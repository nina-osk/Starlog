#![no_std]
//! EstelaEscrow: holds a traveler's crypto payment until Estela confirms the booking.
//!
//! Money can only ever leave the contract towards the Estela treasury (release /
//! the non-refunded part of a partial refund) or back to the traveler.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, Env, Vec,
};

const DAY: u32 = 17_280; // ledgers per day, approx. (5 s per ledger)
// Extend only when an entry is close to archival. Rent is priced by network state size
// and testnet currently sits above its target, so long extensions on every write cost
// thousands of XLM. New entries already start with the network minimum (~7 days).
const TTL_THRESHOLD: u32 = DAY;
const TTL_EXTEND_TO: u32 = 7 * DAY;

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
    pub fn __constructor(env: Env, admin: Address, treasury: Address, tokens: Vec<Address>) {
        let s = env.storage().instance();
        s.set(&DataKey::Admin, &admin);
        s.set(&DataKey::Treasury, &treasury);
        for t in tokens.iter() {
            s.set(&DataKey::Token(t), &true);
        }
    }

    /// Admin registers a booking with the exact price and deadlines (all unix seconds).
    /// The traveler can only pay this exact amount, so they can't choose their own price.
    pub fn create_booking(
        env: Env,
        id: u64,
        traveler: Address,
        token: Address,
        amount: i128,
        pay_before: u64,
        refund_until: u64,
        confirm_by: u64,
    ) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
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

    /// Admin confirms the booking with the providers: funds go to the treasury.
    pub fn release(env: Env, id: u64) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let mut b = Self::load(&env, id)?;
        if b.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        b.status = Status::Released;
        Self::save(&env, id, &b);
        token::Client::new(&env, &b.token).transfer(
            &env.current_contract_address(),
            &Self::treasury(&env),
            &b.amount,
        );
        Ok(())
    }

    /// Admin applies the provider's cancellation policy: `to_traveler` goes back to the
    /// traveler and the rest to the treasury.
    pub fn refund(env: Env, id: u64, to_traveler: i128) -> Result<(), Error> {
        Self::admin(&env).require_auth();
        let mut b = Self::load(&env, id)?;
        if b.status != Status::Funded {
            return Err(Error::InvalidState);
        }
        if to_traveler < 0 || to_traveler > b.amount {
            return Err(Error::InvalidAmount);
        }
        b.status = Status::Refunded;
        Self::save(&env, id, &b);
        let tk = token::Client::new(&env, &b.token);
        let me = env.current_contract_address();
        if to_traveler > 0 {
            tk.transfer(&me, &b.traveler, &to_traveler);
        }
        let rest = b.amount - to_traveler;
        if rest > 0 {
            tk.transfer(&me, &Self::treasury(&env), &rest);
        }
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
