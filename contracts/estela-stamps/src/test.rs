#![cfg(test)]

use super::*;
use estela_pass::{EstelaPass, EstelaPassClient};
use soroban_sdk::testutils::Address as _;

struct Setup<'a> {
    env: Env,
    stamps: EstelaStampsClient<'a>,
    pass: EstelaPassClient<'a>,
    issuer: Address,
    user: Address,
}

/// Real EstelaPass + EstelaStamps, with the stamps contract holding `awarder`.
fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);

    let pass_id = env.register(
        EstelaPass,
        (admin.clone(), String::from_str(&env, "https://estela.example/pass/")),
    );
    let stamps_id = env.register(
        EstelaStamps,
        (
            admin.clone(),
            pass_id.clone(),
            String::from_str(&env, "https://estela.example/stamps/"),
        ),
    );
    let pass = EstelaPassClient::new(&env, &pass_id);
    let stamps = EstelaStampsClient::new(&env, &stamps_id);

    pass.grant_role(&stamps_id, &Symbol::new(&env, "awarder"), &admin);
    let issuer = Address::generate(&env);
    stamps.grant_role(&issuer, &Symbol::new(&env, "issuer"), &admin);

    let user = Address::generate(&env);
    Setup { env, stamps, pass, issuer, user }
}

#[test]
fn event_stamp_mints_and_awards_xp() {
    let s = setup();
    let token = s.stamps.mint_stamp(&s.user, &StampKind::Event, &7, &s.issuer);

    assert_eq!(s.stamps.owner_of(&token), s.user);
    assert_eq!(
        s.stamps.stamp_info(&token),
        Some(Stamp { kind: StampKind::Event, ref_id: 7 })
    );
    assert_eq!(s.stamps.stamp_of(&s.user, &StampKind::Event, &7), Some(token));
    // The first stamp also mints the member's pass.
    assert_eq!(s.pass.xp_of(&s.user), 100);
    assert!(s.pass.pass_of(&s.user).is_some());
}

#[test]
fn trip_stamps_award_less_xp() {
    let s = setup();
    s.stamps.mint_stamp(&s.user, &StampKind::Trip, &42, &s.issuer);
    assert_eq!(s.pass.xp_of(&s.user), 50);
}

#[test]
fn one_stamp_per_user_kind_and_ref() {
    let s = setup();
    s.stamps.mint_stamp(&s.user, &StampKind::Event, &7, &s.issuer);
    assert_eq!(
        s.stamps.try_mint_stamp(&s.user, &StampKind::Event, &7, &s.issuer),
        Err(Ok(Error::AlreadyStamped.into()))
    );
    // Same ref id but another kind, or another event, is fine.
    s.stamps.mint_stamp(&s.user, &StampKind::Trip, &7, &s.issuer);
    s.stamps.mint_stamp(&s.user, &StampKind::Event, &8, &s.issuer);
    assert_eq!(s.pass.xp_of(&s.user), 250);
}

#[test]
fn member_stamps_are_enumerable() {
    let s = setup();
    let a = s.stamps.mint_stamp(&s.user, &StampKind::Event, &1, &s.issuer);
    let b = s.stamps.mint_stamp(&s.user, &StampKind::Event, &2, &s.issuer);
    let other = Address::generate(&s.env);
    s.stamps.mint_stamp(&other, &StampKind::Event, &1, &s.issuer);

    assert_eq!(s.stamps.balance(&s.user), 2);
    assert_eq!(s.stamps.total_supply(), 3);
    assert_eq!(s.stamps.get_owner_token_id(&s.user, &0), a);
    assert_eq!(s.stamps.get_owner_token_id(&s.user, &1), b);
}

#[test]
fn revoke_removes_stamp_and_xp() {
    let s = setup();
    let keep = s.stamps.mint_stamp(&s.user, &StampKind::Event, &1, &s.issuer);
    let bad = s.stamps.mint_stamp(&s.user, &StampKind::Event, &2, &s.issuer);
    assert_eq!(s.pass.xp_of(&s.user), 200);

    s.stamps.revoke_stamp(&bad, &s.issuer);
    assert_eq!(s.pass.xp_of(&s.user), 100);
    assert_eq!(s.stamps.balance(&s.user), 1);
    assert_eq!(s.stamps.total_supply(), 1);
    assert_eq!(s.stamps.get_owner_token_id(&s.user, &0), keep);
    assert_eq!(s.stamps.stamp_info(&bad), None);
    assert!(s.stamps.try_owner_of(&bad).is_err());

    // A revoked stamp can be issued again (e.g. after a mistaken revocation).
    s.stamps.mint_stamp(&s.user, &StampKind::Event, &2, &s.issuer);
    assert_eq!(s.pass.xp_of(&s.user), 200);
}

#[test]
fn revoking_unknown_stamp_fails() {
    let s = setup();
    assert_eq!(
        s.stamps.try_revoke_stamp(&99, &s.issuer),
        Err(Ok(Error::NotFound.into()))
    );
}

#[test]
fn only_issuers_mint_and_revoke() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert!(s
        .stamps
        .try_mint_stamp(&s.user, &StampKind::Event, &1, &stranger)
        .is_err());
    let token = s.stamps.mint_stamp(&s.user, &StampKind::Event, &1, &s.issuer);
    assert!(s.stamps.try_revoke_stamp(&token, &stranger).is_err());
    assert!(s.stamps.try_revoke_stamp(&token, &s.user).is_err());
    assert_eq!(s.stamps.owner_of(&token), s.user);
}

#[test]
fn stamps_cannot_be_transferred_or_approved() {
    let s = setup();
    let other = Address::generate(&s.env);
    let token = s.stamps.mint_stamp(&s.user, &StampKind::Event, &1, &s.issuer);
    assert!(s.stamps.try_transfer(&s.user, &other, &token).is_err());
    assert!(s.stamps.try_transfer_from(&other, &s.user, &other, &token).is_err());
    assert!(s.stamps.try_approve(&s.user, &other, &token, &1000).is_err());
    assert!(s.stamps.try_approve_for_all(&s.user, &other, &1000).is_err());
    assert_eq!(s.stamps.owner_of(&token), s.user);
}

#[test]
fn minting_fails_if_stamps_lost_the_awarder_role() {
    let s = setup();
    // Without the awarder role the XP call fails, so the whole mint is rolled back.
    let admin = s.pass.get_admin().unwrap();
    s.pass
        .revoke_role(&s.stamps.address, &Symbol::new(&s.env, "awarder"), &admin);
    assert!(s
        .stamps
        .try_mint_stamp(&s.user, &StampKind::Event, &1, &s.issuer)
        .is_err());
    assert_eq!(s.stamps.balance(&s.user), 0);
}
