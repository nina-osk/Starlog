#![no_std]
//! EstelaStamps: soulbound NFTs proving a member attended an event or completed a trip.
//!
//! Stamps are minted by the Estela backend (`issuer` role) after a QR check-in or when
//! a trip's return date passes, and each one adds XP to the member's EstelaPass, so
//! this contract must hold the pass's `awarder` role. An issuer can revoke a
//! fraudulent stamp, which takes its XP back; holders can't transfer or burn them.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, Address, Env, String, Symbol, Vec,
};
use stellar_access::access_control::{set_admin, AccessControl};
use stellar_macros::{only_admin, only_role};
use stellar_tokens::non_fungible::{
    enumerable::{Enumerable, NonFungibleEnumerable},
    Base, Compose, NonFungibleToken,
};

const DAY: u32 = 17_280; // ledgers per day, approx. (5 s per ledger)
const TTL_THRESHOLD: u32 = DAY;
const TTL_EXTEND_TO: u32 = 7 * DAY;

const EVENT_XP: u32 = 100;
const TRIP_XP: u32 = 50;

/// The part of EstelaPass the stamps contract uses.
#[contractclient(name = "PassClient")]
pub trait Pass {
    fn add_xp(env: Env, user: Address, xp: u32, caller: Address);
    fn remove_xp(env: Env, user: Address, xp: u32, caller: Address);
}

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StampKind {
    Event,
    Trip,
}

impl StampKind {
    fn xp(self) -> u32 {
        match self {
            StampKind::Event => EVENT_XP,
            StampKind::Trip => TRIP_XP,
        }
    }
}

/// What a stamp proves: `ref_id` is the Estela event id or booking id.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Stamp {
    pub kind: StampKind,
    pub ref_id: u64,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Pass,
    Info(u32),
    Issued(Address, StampKind, u64),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Soulbound = 1,
    AlreadyStamped = 2,
    NotFound = 3,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StampIssued {
    #[topic]
    pub user: Address,
    pub token_id: u32,
    pub kind: StampKind,
    pub ref_id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StampRevoked {
    #[topic]
    pub user: Address,
    pub token_id: u32,
}

#[contract]
pub struct EstelaStamps;

#[contractimpl]
impl EstelaStamps {
    /// `uri` is the metadata base URI: stamp N resolves to `{uri}{N}`.
    pub fn __constructor(e: &Env, admin: Address, pass: Address, uri: String) {
        set_admin(e, &admin);
        e.storage().instance().set(&DataKey::Pass, &pass);
        Self::set_metadata(e, uri);
    }

    /// Points token metadata at a new backend (e.g. once its domain exists).
    #[only_admin]
    pub fn set_base_uri(e: &Env, uri: String) {
        Self::set_metadata(e, uri);
    }

    /// Issues one stamp per (user, kind, ref_id) and adds its XP to the user's pass.
    #[only_role(caller, "issuer")]
    pub fn mint_stamp(e: &Env, user: Address, kind: StampKind, ref_id: u64, caller: Address) -> u32 {
        let issued = DataKey::Issued(user.clone(), kind, ref_id);
        if e.storage().persistent().has(&issued) {
            panic_with_error!(e, Error::AlreadyStamped);
        }
        let token_id = <Self as NonFungibleToken>::ContractType::mint(e, &user);
        Self::store(e, &issued, &token_id);
        Self::store(e, &DataKey::Info(token_id), &Stamp { kind, ref_id });

        Self::pass(e).add_xp(&user, &kind.xp(), &e.current_contract_address());
        StampIssued { user, token_id, kind, ref_id }.publish(e);
        token_id
    }

    /// Removes a fraudulent stamp without its holder's signature and takes its XP back.
    #[only_role(caller, "issuer")]
    pub fn revoke_stamp(e: &Env, token_id: u32, caller: Address) {
        let info: Stamp = e
            .storage()
            .persistent()
            .get(&DataKey::Info(token_id))
            .unwrap_or_else(|| panic_with_error!(e, Error::NotFound));
        let owner = Base::owner_of(e, token_id);

        // Enumerable::burn would require the holder's auth; this is its body minus that.
        Base::update(e, Some(&owner), None, token_id);
        Enumerable::remove_from_enumerations(e, &owner, token_id);
        e.storage().persistent().remove(&DataKey::Info(token_id));
        e.storage()
            .persistent()
            .remove(&DataKey::Issued(owner.clone(), info.kind, info.ref_id));

        Self::pass(e).remove_xp(&owner, &info.kind.xp(), &e.current_contract_address());
        StampRevoked { user: owner, token_id }.publish(e);
    }

    pub fn stamp_info(e: &Env, token_id: u32) -> Option<Stamp> {
        e.storage().persistent().get(&DataKey::Info(token_id))
    }

    /// The token id of `user`'s stamp for this event/booking, if they have one.
    pub fn stamp_of(e: &Env, user: Address, kind: StampKind, ref_id: u64) -> Option<u32> {
        e.storage()
            .persistent()
            .get(&DataKey::Issued(user, kind, ref_id))
    }
}

impl EstelaStamps {
    fn set_metadata(e: &Env, uri: String) {
        Base::set_metadata(
            e,
            uri,
            String::from_str(e, "Estela Stamps"),
            String::from_str(e, "ESTAMP"),
        );
    }

    fn pass(e: &Env) -> PassClient<'_> {
        let address: Address = e.storage().instance().get(&DataKey::Pass).unwrap();
        PassClient::new(e, &address)
    }

    fn store<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(e: &Env, key: &DataKey, value: &V) {
        e.storage().persistent().set(key, value);
        e.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[contractimpl(contracttrait)]
impl NonFungibleToken for EstelaStamps {
    type ContractType = Compose<(Enumerable,)>;

    fn transfer(e: &Env, _from: Address, _to: Address, _token_id: u32) {
        panic_with_error!(e, Error::Soulbound)
    }

    fn transfer_from(e: &Env, _spender: Address, _from: Address, _to: Address, _token_id: u32) {
        panic_with_error!(e, Error::Soulbound)
    }

    fn approve(e: &Env, _approver: Address, _approved: Address, _token_id: u32, _live_until_ledger: u32) {
        panic_with_error!(e, Error::Soulbound)
    }

    fn approve_for_all(e: &Env, _owner: Address, _operator: Address, _live_until_ledger: u32) {
        panic_with_error!(e, Error::Soulbound)
    }
}

#[contractimpl(contracttrait)]
impl NonFungibleEnumerable for EstelaStamps {}

#[contractimpl(contracttrait)]
impl AccessControl for EstelaStamps {}

mod test;
