#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env,
};

const PRICE: i128 = 9_000_000_000; // 900 USDC, 7 decimals
const START: u64 = 1_000_000;

struct Setup<'a> {
    env: Env,
    client: EstelaEscrowClient<'a>,
    token: TokenClient<'a>,
    treasury: Address,
    traveler: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let traveler = Address::generate(&env);

    let issuer = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(issuer);
    StellarAssetClient::new(&env, &sac.address()).mint(&traveler, &PRICE);

    let contract_id = env.register(
        EstelaEscrow,
        (admin, treasury.clone(), vec![&env, sac.address()]),
    );
    let client = EstelaEscrowClient::new(&env, &contract_id);
    let token = TokenClient::new(&env, &sac.address());

    Setup { env, client, token, treasury, traveler }
}

/// Booking 1: pay within 15 min, cancel with full refund for 1 day, confirm within 2 days.
fn create(s: &Setup) {
    s.client.create_booking(
        &1,
        &s.traveler,
        &s.token.address,
        &PRICE,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
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
    create(&s);
    s.client.fund(&1);
    advance_to(&s.env, START + 86_400);
    s.client.cancel(&1);
    assert_eq!(s.client.get_booking(&1).status, Status::Refunded);
    assert_eq!(s.token.balance(&s.traveler), PRICE);
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
    s.client.refund(&1, &back);
    assert_eq!(s.token.balance(&s.traveler), back);
    assert_eq!(s.token.balance(&s.treasury), PRICE - back);
    assert_eq!(s.token.balance(&s.client.address), 0);
}

#[test]
fn refund_rejects_invalid_amounts() {
    let s = setup();
    create(&s);
    s.client.fund(&1);
    assert_eq!(s.client.try_refund(&1, &-1), Err(Ok(Error::InvalidAmount)));
    assert_eq!(
        s.client.try_refund(&1, &(PRICE + 1)),
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
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
    assert_eq!(res, Err(Ok(Error::TokenNotAllowed)));
}

#[test]
fn duplicate_id_and_bad_inputs_fail() {
    let s = setup();
    create(&s);
    let again = s.client.try_create_booking(
        &1,
        &s.traveler,
        &s.token.address,
        &PRICE,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
    assert_eq!(again, Err(Ok(Error::AlreadyExists)));

    let zero = s.client.try_create_booking(
        &2,
        &s.traveler,
        &s.token.address,
        &0,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
    assert_eq!(zero, Err(Ok(Error::InvalidAmount)));

    let past = s.client.try_create_booking(
        &3,
        &s.traveler,
        &s.token.address,
        &PRICE,
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
