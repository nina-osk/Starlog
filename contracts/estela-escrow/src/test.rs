#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

const PRICE: i128 = 9_000_000_000; // 900 USDC, 7 decimals
const TICKET: i128 = 1_500_000_000; // organizer's 150 USDC share
const START: u64 = 1_000_000;

/// Stand-in for EstelaPass: records the XP it receives and who granted it.
#[contract]
pub struct MockLoyalty;

#[contractimpl]
impl MockLoyalty {
    pub fn add_xp(env: Env, user: Address, xp: u32, caller: Address) {
        caller.require_auth();
        let total: u32 = env.storage().instance().get(&user).unwrap_or(0);
        env.storage().instance().set(&user, &(total + xp));
        env.storage().instance().set(&0u32, &caller);
    }

    pub fn xp_of(env: Env, user: Address) -> u32 {
        env.storage().instance().get(&user).unwrap_or(0)
    }

    pub fn last_caller(env: Env) -> Address {
        env.storage().instance().get(&0u32).unwrap()
    }
}

/// A loyalty contract that always fails, e.g. after the escrow lost its role.
#[contract]
pub struct BrokenLoyalty;

#[contractimpl]
impl BrokenLoyalty {
    pub fn add_xp(_env: Env, _user: Address, _xp: u32, _caller: Address) {
        panic!("awarder role revoked");
    }
}

struct Setup<'a> {
    env: Env,
    client: EstelaEscrowClient<'a>,
    token: TokenClient<'a>,
    loyalty: MockLoyaltyClient<'a>,
    treasury: Address,
    traveler: Address,
    organizer: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let traveler = Address::generate(&env);
    let organizer = Address::generate(&env);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    StellarAssetClient::new(&env, &sac.address()).mint(&traveler, &PRICE);

    let loyalty_id = env.register(MockLoyalty, ());
    let contract_id = env.register(
        EstelaEscrow,
        (admin, treasury.clone(), loyalty_id.clone(), vec![&env, sac.address()]),
    );
    let client = EstelaEscrowClient::new(&env, &contract_id);
    let token = TokenClient::new(&env, &sac.address());
    let loyalty = MockLoyaltyClient::new(&env, &loyalty_id);

    Setup { env, client, token, loyalty, treasury, traveler, organizer }
}

/// Booking 1 (no organizer): pay within 15 min, cancel with full refund for 1 day,
/// confirm within 2 days.
fn create(s: &Setup) {
    s.client.create_booking(
        &1,
        &s.traveler,
        &s.token.address,
        &PRICE,
        &None,
        &0,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
}

/// Booking 1 as a package that includes a partner organizer's ticket.
fn create_with_payee(s: &Setup) {
    s.client.create_booking(
        &1,
        &s.traveler,
        &s.token.address,
        &PRICE,
        &Some(s.organizer.clone()),
        &TICKET,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
}

fn try_create(s: &Setup, id: u64, amount: i128, payee: Option<Address>, payee_amount: i128) -> Result<(), Error> {
    match s.client.try_create_booking(
        &id,
        &s.traveler,
        &s.token.address,
        &amount,
        &payee,
        &payee_amount,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    ) {
        Ok(_) => Ok(()),
        Err(Ok(e)) => Err(e),
        Err(Err(e)) => panic!("unexpected host error: {e:?}"),
    }
}

fn advance_to(env: &Env, ts: u64) {
    env.ledger().set_timestamp(ts);
}

#[test]
fn happy_path_create_fund_release() {
    let s = setup();
    create(&s);
    assert_eq!(s.client.get_booking(&1).status, Status::Pending);

    s.client.fund(&1);
    assert_eq!(s.client.get_booking(&1).status, Status::Funded);
    assert_eq!(s.token.balance(&s.client.address), PRICE);
    assert_eq!(s.token.balance(&s.traveler), 0);

    s.client.release(&1);
    assert_eq!(s.client.get_booking(&1).status, Status::Released);
    assert_eq!(s.token.balance(&s.treasury), PRICE);
    assert_eq!(s.token.balance(&s.client.address), 0);
}

#[test]
fn release_splits_between_payee_and_treasury() {
    let s = setup();
    create_with_payee(&s);
    s.client.fund(&1);
    s.client.release(&1);
    assert_eq!(s.token.balance(&s.organizer), TICKET);
    assert_eq!(s.token.balance(&s.treasury), PRICE - TICKET);
    assert_eq!(s.token.balance(&s.client.address), 0);
}

#[test]
fn release_awards_xp_from_the_escrow() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    assert_eq!(s.loyalty.xp_of(&s.traveler), 0);

    s.client.release(&1);
    assert_eq!(s.loyalty.xp_of(&s.traveler), 900);
    assert_eq!(s.loyalty.last_caller(), s.client.address);
}

#[test]
fn refunds_never_award_xp() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    s.client.cancel(&1);
    assert_eq!(s.loyalty.xp_of(&s.traveler), 0);
}

#[test]
fn broken_loyalty_does_not_block_release() {
    let s = setup();
    let broken = s.env.register(BrokenLoyalty, ());
    let id = s.env.register(
        EstelaEscrow,
        (
            Address::generate(&s.env),
            s.treasury.clone(),
            broken,
            vec![&s.env, s.token.address.clone()],
        ),
    );
    let client = EstelaEscrowClient::new(&s.env, &id);
    client.create_booking(
        &1,
        &s.traveler,
        &s.token.address,
        &PRICE,
        &None,
        &0,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
    client.fund(&1);
    client.release(&1);
    assert_eq!(client.get_booking(&1).status, Status::Released);
    assert_eq!(s.token.balance(&s.treasury), PRICE);
}

#[test]
fn funding_twice_fails() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    assert_eq!(s.client.try_fund(&1), Err(Ok(Error::InvalidState)));
}

#[test]
fn funding_after_pay_before_fails() {
    let s = setup();
    create(&s);
    advance_to(&s.env, START + 901);
    assert_eq!(s.client.try_fund(&1), Err(Ok(Error::PaymentWindowClosed)));
}

#[test]
fn cancel_within_window_refunds_everything() {
    let s = setup();
    create_with_payee(&s);
    s.client.fund(&1);
    advance_to(&s.env, START + 86_400);
    s.client.cancel(&1);
    assert_eq!(s.client.get_booking(&1).status, Status::Refunded);
    assert_eq!(s.token.balance(&s.traveler), PRICE);
    assert_eq!(s.token.balance(&s.organizer), 0);
}

#[test]
fn cancel_after_window_fails() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    advance_to(&s.env, START + 86_401);
    assert_eq!(s.client.try_cancel(&1), Err(Ok(Error::RefundWindowClosed)));
}

#[test]
fn reclaim_only_after_confirm_by() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    advance_to(&s.env, START + 2 * 86_400);
    assert_eq!(s.client.try_reclaim(&1), Err(Ok(Error::TooEarly)));

    advance_to(&s.env, START + 2 * 86_400 + 1);
    s.client.reclaim(&1);
    assert_eq!(s.token.balance(&s.traveler), PRICE);
    assert_eq!(s.client.get_booking(&1).status, Status::Refunded);
}

#[test]
fn partial_refund_splits_between_traveler_and_treasury() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    let back = PRICE * 70 / 100;
    s.client.refund(&1, &back, &0);
    assert_eq!(s.token.balance(&s.traveler), back);
    assert_eq!(s.token.balance(&s.treasury), PRICE - back);
    assert_eq!(s.token.balance(&s.client.address), 0);
}

#[test]
fn partial_refund_splits_three_ways() {
    let s = setup();
    create_with_payee(&s);
    s.client.fund(&1);
    let back = PRICE / 2;
    let keep = TICKET / 2; // organizer keeps half its ticket under its policy
    s.client.refund(&1, &back, &keep);
    assert_eq!(s.token.balance(&s.traveler), back);
    assert_eq!(s.token.balance(&s.organizer), keep);
    assert_eq!(s.token.balance(&s.treasury), PRICE - back - keep);
    assert_eq!(s.token.balance(&s.client.address), 0);
}

#[test]
fn refund_rejects_invalid_amounts() {
    let s = setup();
    create_with_payee(&s);
    s.client.fund(&1);
    assert_eq!(s.client.try_refund(&1, &-1, &0), Err(Ok(Error::InvalidAmount)));
    assert_eq!(s.client.try_refund(&1, &0, &-1), Err(Ok(Error::InvalidAmount)));
    assert_eq!(
        s.client.try_refund(&1, &(PRICE + 1), &0),
        Err(Ok(Error::InvalidAmount))
    );
    // The payee can never get more than its share.
    assert_eq!(
        s.client.try_refund(&1, &0, &(TICKET + 1)),
        Err(Ok(Error::InvalidAmount))
    );
    // Traveler + payee can't exceed what was paid.
    assert_eq!(
        s.client.try_refund(&1, &(PRICE - TICKET + 1), &TICKET),
        Err(Ok(Error::InvalidAmount))
    );
}

#[test]
fn release_without_admin_signature_fails() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    // Drop the blanket auth mock: nobody signs the release.
    s.env.set_auths(&[]);
    assert!(s.client.try_release(&1).is_err());
    assert_eq!(s.client.get_booking(&1).status, Status::Funded);
}

#[test]
fn token_not_allowed_fails() {
    let s = setup();
    let other = s
        .env
        .register_stellar_asset_contract_v2(Address::generate(&s.env))
        .address();
    let res = s.client.try_create_booking(
        &1,
        &s.traveler,
        &other,
        &PRICE,
        &None,
        &0,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
    assert_eq!(res, Err(Ok(Error::TokenNotAllowed)));
}

#[test]
fn invalid_payee_configurations_fail() {
    let s = setup();
    let org = Some(s.organizer.clone());
    // A share without a payee.
    assert_eq!(try_create(&s, 1, PRICE, None, TICKET), Err(Error::InvalidPayee));
    // A payee without a share.
    assert_eq!(try_create(&s, 2, PRICE, org.clone(), 0), Err(Error::InvalidPayee));
    // A share larger than the booking.
    assert_eq!(try_create(&s, 3, PRICE, org.clone(), PRICE + 1), Err(Error::InvalidPayee));
    // The whole amount to the payee is allowed (no Estela commission).
    assert_eq!(try_create(&s, 4, PRICE, org, PRICE), Ok(()));
}

#[test]
fn duplicate_id_and_bad_inputs_fail() {
    let s = setup();
    create(&s);
    assert_eq!(try_create(&s, 1, PRICE, None, 0), Err(Error::AlreadyExists));
    assert_eq!(try_create(&s, 2, 0, None, 0), Err(Error::InvalidAmount));

    let past = s.client.try_create_booking(
        &3,
        &s.traveler,
        &s.token.address,
        &PRICE,
        &None,
        &0,
        &START,
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
    assert_eq!(past, Err(Ok(Error::InvalidDeadlines)));
}

#[test]
fn missing_booking_is_not_found() {
    let s = setup();
    assert_eq!(s.client.try_get_booking(&42), Err(Ok(Error::NotFound)));
}
