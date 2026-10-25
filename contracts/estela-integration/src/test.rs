extern crate std;

use estela_escrow::{EstelaEscrow, EstelaEscrowClient, Status};
use estela_pass::{EstelaPass, EstelaPassClient, Level};
use estela_stamps::{EstelaStamps, EstelaStampsClient, StampKind};
use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, String, Symbol,
};

const UNIT: i128 = 10_000_000; // 7 decimals
const START: u64 = 1_000_000;

struct Estela<'a> {
    env: Env,
    escrow: EstelaEscrowClient<'a>,
    pass: EstelaPassClient<'a>,
    stamps: EstelaStampsClient<'a>,
    usdc: TokenClient<'a>,
    admin: Address,
    backend: Address,
    treasury: Address,
    organizer: Address,
    traveler: Address,
}

/// Deploys the three contracts the way the testnet deploy will, with real roles:
/// the escrow and the stamps contract are `awarder`s on the pass, the backend is the
/// stamps `issuer`.
fn deploy() -> Estela<'static> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(START);

    let admin = Address::generate(&env);
    let backend = Address::generate(&env);
    let treasury = Address::generate(&env);
    let organizer = Address::generate(&env);
    let traveler = Address::generate(&env);

    let sac = env.register_stellar_asset_contract_v2(Address::generate(&env));
    StellarAssetClient::new(&env, &sac.address()).mint(&traveler, &(5_000 * UNIT));

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
    let escrow_id = env.register(
        EstelaEscrow,
        (
            admin.clone(),
            treasury.clone(),
            pass_id.clone(),
            vec![&env, sac.address()],
        ),
    );

    let pass = EstelaPassClient::new(&env, &pass_id);
    let stamps = EstelaStampsClient::new(&env, &stamps_id);
    let awarder = Symbol::new(&env, "awarder");
    pass.grant_role(&escrow_id, &awarder, &admin);
    pass.grant_role(&stamps_id, &awarder, &admin);
    pass.grant_role(&backend, &awarder, &admin);
    stamps.grant_role(&backend, &Symbol::new(&env, "issuer"), &admin);

    Estela {
        escrow: EstelaEscrowClient::new(&env, &escrow_id),
        usdc: TokenClient::new(&env, &sac.address()),
        env,
        pass,
        stamps,
        admin,
        backend,
        treasury,
        organizer,
        traveler,
    }
}

fn book(e: &Estela, id: u64, amount: i128, payee: Option<Address>, payee_amount: i128) {
    e.escrow.create_booking(
        &id,
        &e.traveler,
        &e.usdc.address,
        &amount,
        &payee,
        &payee_amount,
        &(START + 900),
        &(START + 86_400),
        &(START + 2 * 86_400),
    );
}

#[test]
fn package_journey_pays_everyone_and_levels_up() {
    let e = deploy();

    // 900 USDC package: 150 ticket (organizer keeps 138 after 8 %), 750 travel.
    book(&e, 1, 900 * UNIT, Some(e.organizer.clone()), 138 * UNIT);
    e.escrow.fund(&1);
    assert_eq!(e.pass.pass_of(&e.traveler), None);

    // Duffel confirmed off-chain: release splits the money and awards XP.
    e.escrow.release(&1);
    assert_eq!(e.escrow.get_booking(&1).status, Status::Released);
    assert_eq!(e.usdc.balance(&e.organizer), 138 * UNIT);
    assert_eq!(e.usdc.balance(&e.treasury), 762 * UNIT);
    assert_eq!(e.usdc.balance(&e.escrow.address), 0);
    assert_eq!(e.pass.xp_of(&e.traveler), 900);
    assert_eq!(e.pass.level_of(&e.traveler), Level::Voyager);
    assert_eq!(e.pass.discount_bps_of(&e.traveler), 500);

    // QR check-in at the event, then the trip completes.
    e.stamps.mint_stamp(&e.traveler, &StampKind::Event, &10, &e.backend);
    e.stamps.mint_stamp(&e.traveler, &StampKind::Trip, &1, &e.backend);
    assert_eq!(e.pass.xp_of(&e.traveler), 1_050);
    assert_eq!(e.stamps.balance(&e.traveler), 2);
    // Still a single pass, minted on the first release.
    assert_eq!(e.pass.balance(&e.traveler), 1);

    // A second, Estela-only trip pushes the member to Globetrotter.
    book(&e, 2, 1_000 * UNIT, None, 0);
    e.escrow.fund(&2);
    e.escrow.release(&2);
    assert_eq!(e.pass.xp_of(&e.traveler), 2_050);
    assert_eq!(e.pass.level_of(&e.traveler), Level::Globetrotter);
    assert_eq!(e.usdc.balance(&e.treasury), 1_762 * UNIT);
}

#[test]
fn cancelled_booking_pays_nobody_and_awards_nothing() {
    let e = deploy();
    book(&e, 1, 900 * UNIT, Some(e.organizer.clone()), 138 * UNIT);
    e.escrow.fund(&1);
    e.escrow.cancel(&1);

    assert_eq!(e.usdc.balance(&e.traveler), 5_000 * UNIT);
    assert_eq!(e.usdc.balance(&e.organizer), 0);
    assert_eq!(e.usdc.balance(&e.treasury), 0);
    assert_eq!(e.pass.xp_of(&e.traveler), 0);
    assert_eq!(e.pass.pass_of(&e.traveler), None);
}

#[test]
fn backend_takes_xp_back_after_a_late_refund() {
    let e = deploy();
    book(&e, 1, 600 * UNIT, None, 0);
    e.escrow.fund(&1);
    e.escrow.release(&1);
    assert_eq!(e.pass.level_of(&e.traveler), Level::Voyager);

    // Estela refunds the customer off-chain after confirmation (e.g. airline
    // cancelled): the backend removes the XP that booking earned.
    e.pass.remove_xp(&e.traveler, &600, &e.backend);
    assert_eq!(e.pass.xp_of(&e.traveler), 0);
    assert_eq!(e.pass.level_of(&e.traveler), Level::Explorer);
}

#[test]
fn release_still_pays_if_escrow_loses_awarder_role() {
    let e = deploy();
    e.pass
        .revoke_role(&e.escrow.address, &Symbol::new(&e.env, "awarder"), &e.admin);

    book(&e, 1, 900 * UNIT, Some(e.organizer.clone()), 138 * UNIT);
    e.escrow.fund(&1);
    e.escrow.release(&1);

    // Money moves even though the real pass rejected the XP award...
    assert_eq!(e.usdc.balance(&e.organizer), 138 * UNIT);
    assert_eq!(e.usdc.balance(&e.treasury), 762 * UNIT);
    assert_eq!(e.pass.xp_of(&e.traveler), 0);

    // ...and the backend can grant the missing XP afterwards.
    e.pass.add_xp(&e.traveler, &900, &e.backend);
    assert_eq!(e.pass.level_of(&e.traveler), Level::Voyager);
}

#[test]
fn release_awards_xp_with_only_the_admin_signature() {
    let e = deploy();
    book(&e, 1, 900 * UNIT, None, 0);
    e.escrow.fund(&1);

    // No blanket mock: the admin signs release() and nothing else. The escrow's own
    // authorization for add_xp must come from it being the direct caller.
    e.env.mock_auths(&[MockAuth {
        address: &e.admin,
        invoke: &MockAuthInvoke {
            contract: &e.escrow.address,
            fn_name: "release",
            args: (1u64,).into_val(&e.env),
            sub_invokes: &[],
        },
    }]);
    e.escrow.release(&1);
    assert_eq!(e.pass.xp_of(&e.traveler), 900);
}

#[test]
fn stamp_xp_needs_only_the_issuer_signature() {
    let e = deploy();
    let args = (e.traveler.clone(), StampKind::Event, 10u64, e.backend.clone());
    e.env.mock_auths(&[MockAuth {
        address: &e.backend,
        invoke: &MockAuthInvoke {
            contract: &e.stamps.address,
            fn_name: "mint_stamp",
            args: args.into_val(&e.env),
            sub_invokes: &[],
        },
    }]);
    e.stamps.mint_stamp(&e.traveler, &StampKind::Event, &10, &e.backend);
    assert_eq!(e.pass.xp_of(&e.traveler), 100);
}
