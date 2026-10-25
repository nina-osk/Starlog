#![no_std]
//! EstelaEscrow: holds a traveler's crypto payment until Estela confirms the booking.
//!
//! Money can only ever leave the contract towards the traveler, the booking's payee
//! (a partner organizer, up to its `payee_amount`) or the Estela treasury.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, token,
    Address, Env, Vec,
};

const DAY: u32 = 17_280; // ledgers per day, approx. (5 s per ledger)
// Extend only when an entry is close to archival. Rent is priced by network state size
// and testnet currently sits above its target, so long extensions on every write cost
// thousands of XLM. New entries already start with the network minimum (~7 days).
const TTL_THRESHOLD: u32 = DAY;
const TTL_EXTEND_TO: u32 = 7 * DAY;
// USDC, EURC and XLM all use 7 decimals: 1 XP per whole unit paid.
const XP_UNIT: i128 = 10_000_000;

/// The part of EstelaPass the escrow uses. The escrow must hold its `awarder` role.
#[contractclient(name = "LoyaltyClient")]
pub trait Loyalty {
    fn add_xp(env: Env, user: Address, xp: u32, caller: Address);
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Status {
    Pending,
    Funded,
    Released,
    Refunded,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Booking {
    pub traveler: Address,
    pub token: Address,
    pub amount: i128,
    /// Partner organizer paid directly on release; `None` for Estela-only bookings.
    pub payee: Option<Address>,
    /// The payee's share of `amount`; the rest goes to the treasury.
    pub payee_amount: i128,
    pub pay_before: u64,
    pub refund_until: u64,
    pub confirm_by: u64,
    pub status: Status,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Treasury,
    Loyalty,
    Token(Address),
    Booking(u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyExists = 1,
    NotFound = 2,
    InvalidState = 3,
    PaymentWindowClosed = 4,
    RefundWindowClosed = 5,
    TooEarly = 6,
    TokenNotAllowed = 7,
    InvalidAmount = 8,
    InvalidDeadlines = 9,
    InvalidPayee = 10,
}

/// Emitted on every state change, so the backend can follow bookings from chain events.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BookingChanged {
    #[topic]
    pub id: u64,
    pub status: Status,
    pub amount: i128,
}

#[contract]
pub struct EstelaEscrow;

#[contractimpl]
impl EstelaEscrow {
    pub fn __constructor(
        env: Env,
        admin: Address,
        treasury: Address,
        loyalty: Address,
        tokens: Vec<Address>,
    ) {
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Treasury, &treasury);
        s.set(&DataKey::Loyalty, &loyalty);
        for t in tokens.iter() {
            s.set(&DataKey::Token(t), &true);
        }
    }

    /// Admin registers a booking with the exact price and deadlines (all unix seconds).
    /// The traveler can only pay this exact amount, so they can't choose their own price.
    /// A partner organizer (`payee`) gets `payee_amount` of it on release.
    pub fn create_booking(
        env: Env,
        id: u64,
        traveler: Address,
        token: Address,
        amount: i128,
        payee: Option<Address>,
        payee_amount: i128,
        pay_before: u64,
        refund_until: u64,
        confirm_by: u64,
    ) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        let payee_ok = match payee {
            Some(_) => payee_amount > 0 && payee_amount <= amount,
            None => payee_amount == 0,
        };
        if !payee_ok {
            return Err(Error::InvalidPayee);
        }
        if !env.storage().instance().has(&DataKey::Token(token.clone())) {
            return Err(Error::TokenNotAllowed);
        }
        if pay_before <= env.ledger().timestamp() || confirm_by < pay_before {
            return Err(Error::InvalidDeadlines);
        }
        if env.storage().persistent().has(&DataKey::Booking(id)) {
            return Err(Error::AlreadyExists);
        }
        let b = Booking {
            traveler,
            token,
            amount,
            payee,
            payee_amount,
            pay_before,
            refund_until,
            confirm_by,
            status: Status::Pending,
        };
        Self::save(&env, id, &b);
        Ok(())
    }

    /// Traveler pays the booking: the exact amount moves from their wallet into the contract.
    pub fn fund(env: Env, id: u64) -> Result<(), Error> {
        let mut b = Self::load(&env, id)?;
        b.traveler.require_auth();
        if b.status != Status::Pending {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() > b.pay_before {
            return Err(Error::PaymentWindowClosed);
        }
        b.status = Status::Funded;
        Self::save(&env, id, &b);
        token::Client::new(&env, &b.token).transfer(
            &b.traveler,
            &env.current_contract_address(),
            &b.amount,
        );
        Ok(())
    }

    /// Admin confirms the booking with the providers: the payee gets its share, the
    /// treasury the rest, and the traveler earns XP.
    pub fn release(env: Env, id: u64) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let mut b = Self::load(&env, id)?;
        if b.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        b.status = Status::Released;
        Self::save(&env, id, &b);
        Self::pay_out(&env, &b, b.payee_amount, b.amount - b.payee_amount);

        // A loyalty failure must never lock the funds, so its result is ignored:
        // the backend (also an awarder) can grant the missing XP later.
        let xp = u32::try_from(b.amount / XP_UNIT).unwrap_or(u32::MAX);
        if xp > 0 {
            let _ = LoyaltyClient::new(&env, &Self::loyalty(&env)).try_add_xp(
                &b.traveler,
                &xp,
                &env.current_contract_address(),
            );
        }
        Ok(())
    }

    /// Admin applies the cancellation policy: `to_traveler` goes back to the traveler,
    /// `to_payee` (at most its `payee_amount`) to the organizer, and the rest to the
    /// treasury.
    pub fn refund(env: Env, id: u64, to_traveler: i128, to_payee: i128) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let mut b = Self::load(&env, id)?;
        if b.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        if to_traveler < 0 || to_payee < 0 || to_payee > b.payee_amount {
            return Err(Error::InvalidAmount);
        }
        let rest = b.amount - to_traveler - to_payee;
        if rest < 0 {
            return Err(Error::InvalidAmount);
        }
        b.status = Status::Refunded;
        Self::save(&env, id, &b);
        if to_traveler > 0 {
            token::Client::new(&env, &b.token).transfer(
                &env.current_contract_address(),
                &b.traveler,
                &to_traveler,
            );
        }
        Self::pay_out(&env, &b, to_payee, rest);
        Ok(())
    }

    /// Traveler cancels before `refund_until` and gets 100 % back.
    pub fn cancel(env: Env, id: u64) -> Result<(), Error> {
        let mut b = Self::load(&env, id)?;
        b.traveler.require_auth();
        if b.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() > b.refund_until {
            return Err(Error::RefundWindowClosed);
        }
        b.status = Status::Refunded;
        Self::save(&env, id, &b);
        Self::pay_back(&env, &b);
        Ok(())
    }

    /// Traveler takes 100 % back if Estela didn't confirm before `confirm_by`.
    pub fn reclaim(env: Env, id: u64) -> Result<(), Error> {
        let mut b = Self::load(&env, id)?;
        b.traveler.require_auth();
        if b.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        if env.ledger().timestamp() <= b.confirm_by {
            return Err(Error::TooEarly);
        }
        b.status = Status::Refunded;
        Self::save(&env, id, &b);
        Self::pay_back(&env, &b);
        Ok(())
    }

    pub fn get_booking(env: Env, id: u64) -> Result<Booking, Error> {
        Self::load(&env, id)
    }

    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage().instance().has(&DataKey::Token(token))
    }

    pub fn treasury_address(env: Env) -> Address {
        Self::treasury(&env)
    }
}

impl EstelaEscrow {
    fn admin(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Admin).unwrap()
    }

    fn treasury(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Treasury).unwrap()
    }

    fn loyalty(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Loyalty).unwrap()
    }

    /// Sends `to_payee` to the booking's payee and `to_treasury` to the treasury.
    fn pay_out(env: &Env, b: &Booking, to_payee: i128, to_treasury: i128) {
        let tk = token::Client::new(env, &b.token);
        let me = env.current_contract_address();
        if let Some(payee) = &b.payee {
            if to_payee > 0 {
                tk.transfer(&me, payee, &to_payee);
            }
        }
        if to_treasury > 0 {
            tk.transfer(&me, &Self::treasury(env), &to_treasury);
        }
    }

    fn load(env: &Env, id: u64) -> Result<Booking, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Booking(id))
            .ok_or(Error::NotFound)
    }

    fn pay_back(env: &Env, b: &Booking) {
        token::Client::new(env, &b.token).transfer(
            &env.current_contract_address(),
            &b.traveler,
            &b.amount,
        );
    }

    fn save(env: &Env, id: u64, b: &Booking) {
        let key = DataKey::Booking(id);
        env.storage().persistent().set(&key, b);
        env.storage()
            .persistent()
            .extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        env.storage()
            .instance()
            .extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        BookingChanged {
            id,
            status: b.status,
            amount: b.amount,
        }
        .publish(env);
    }
}

mod test;
