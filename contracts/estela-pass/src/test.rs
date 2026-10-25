#![cfg(test)]

use super::*;
use soroban_sdk::testutils::Address as _;

struct Setup<'a> {
    env: Env,
    client: EstelaPassClient<'a>,
    awarder: Address,
    user: Address,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let id = env.register(
        EstelaPass,
        (admin.clone(), String::from_str(&env, "https://estela.example/pass/")),
    );
    let client = EstelaPassClient::new(&env, &id);
    let awarder = Address::generate(&env);
    client.grant_role(&awarder, &Symbol::new(&env, "awarder"), &admin);
    let user = Address::generate(&env);
    Setup { env, client, awarder, user }
}

#[test]
fn first_xp_mints_the_pass() {
    let s = setup();
    assert_eq!(s.client.pass_of(&s.user), None);
    assert_eq!(s.client.balance(&s.user), 0);

    s.client.add_xp(&s.user, &100, &s.awarder);
    let token = s.client.pass_of(&s.user).unwrap();
    assert_eq!(s.client.owner_of(&token), s.user);
    assert_eq!(s.client.xp_of(&s.user), 100);
}

#[test]
fn one_pass_per_member_and_xp_accumulates() {
    let s = setup();
    s.client.add_xp(&s.user, &100, &s.awarder);
    s.client.add_xp(&s.user, &250, &s.awarder);
    assert_eq!(s.client.balance(&s.user), 1);
    assert_eq!(s.client.xp_of(&s.user), 350);

    let other = Address::generate(&s.env);
    s.client.add_xp(&other, &1, &s.awarder);
    assert_ne!(s.client.pass_of(&other), s.client.pass_of(&s.user));
}

#[test]
fn levels_and_discounts_follow_thresholds() {
    let s = setup();
    let cases = [
        (0, Level::Explorer, 0),
        (499, Level::Explorer, 0),
        (500, Level::Voyager, 500),
        (1_999, Level::Voyager, 500),
        (2_000, Level::Globetrotter, 1_000),
        (4_999, Level::Globetrotter, 1_000),
        (5_000, Level::Legend, 1_500),
    ];
    let mut xp = 0;
    for (target, level, bps) in cases {
        s.client.add_xp(&s.user, &(target - xp), &s.awarder);
        xp = target;
        assert_eq!(s.client.level_of(&s.user), level, "at {target} XP");
        assert_eq!(s.client.discount_bps_of(&s.user), bps, "at {target} XP");
    }
}

#[test]
fn remove_xp_lowers_level_and_never_underflows() {
    let s = setup();
    s.client.add_xp(&s.user, &600, &s.awarder);
    assert_eq!(s.client.level_of(&s.user), Level::Voyager);

    s.client.remove_xp(&s.user, &200, &s.awarder);
    assert_eq!(s.client.xp_of(&s.user), 400);
    assert_eq!(s.client.level_of(&s.user), Level::Explorer);

    s.client.remove_xp(&s.user, &1_000, &s.awarder);
    assert_eq!(s.client.xp_of(&s.user), 0);
    // Losing XP never takes the pass away.
    assert_eq!(s.client.balance(&s.user), 1);
}

#[test]
fn xp_saturates_instead_of_overflowing() {
    let s = setup();
    s.client.add_xp(&s.user, &u32::MAX, &s.awarder);
    s.client.add_xp(&s.user, &10, &s.awarder);
    assert_eq!(s.client.xp_of(&s.user), u32::MAX);
}

#[test]
fn only_awarders_change_xp() {
    let s = setup();
    let stranger = Address::generate(&s.env);
    assert!(s.client.try_add_xp(&s.user, &100, &stranger).is_err());
    s.client.add_xp(&s.user, &100, &s.awarder);
    assert!(s.client.try_remove_xp(&s.user, &100, &stranger).is_err());
    assert_eq!(s.client.xp_of(&s.user), 100);
}

#[test]
fn pass_cannot_be_transferred_or_approved() {
    let s = setup();
    let other = Address::generate(&s.env);
    s.client.add_xp(&s.user, &100, &s.awarder);
    let token = s.client.pass_of(&s.user).unwrap();

    assert!(s.client.try_transfer(&s.user, &other, &token).is_err());
    assert!(s.client.try_transfer_from(&other, &s.user, &other, &token).is_err());
    assert!(s.client.try_approve(&s.user, &other, &token, &1000).is_err());
    assert!(s.client.try_approve_for_all(&s.user, &other, &1000).is_err());
    assert_eq!(s.client.owner_of(&token), s.user);
}

#[test]
fn metadata_points_to_the_backend() {
    let s = setup();
    s.client.add_xp(&s.user, &1, &s.awarder);
    let token = s.client.pass_of(&s.user).unwrap();
    assert_eq!(s.client.name(), String::from_str(&s.env, "Estela Pass"));
    assert_eq!(s.client.symbol(), String::from_str(&s.env, "EPASS"));
    assert_eq!(
        s.client.token_uri(&token),
        String::from_str(&s.env, "https://estela.example/pass/0")
    );
}

#[test]
fn admin_can_move_metadata_to_a_new_backend() {
    let s = setup();
    s.client.add_xp(&s.user, &1, &s.awarder);
    s.client
        .set_base_uri(&String::from_str(&s.env, "https://api.estela.app/meta/pass/"));
    assert_eq!(
        s.client.token_uri(&0),
        String::from_str(&s.env, "https://api.estela.app/meta/pass/0")
    );
    assert_eq!(s.client.name(), String::from_str(&s.env, "Estela Pass"));

    // Nobody but the admin can change it.
    s.env.set_auths(&[]);
    assert!(s
        .client
        .try_set_base_uri(&String::from_str(&s.env, "https://evil.example/"))
        .is_err());
}
