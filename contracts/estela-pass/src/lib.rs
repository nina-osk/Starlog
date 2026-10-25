#![no_std]
//! EstelaPass: one soulbound membership NFT per customer, holding their XP and level.
//!
//! Built on OpenZeppelin's NonFungibleToken; every transfer/approval entry point is
//! overridden to fail, so a pass can never leave the wallet it was minted to. Passes
//! are minted lazily on the first XP award, by an address holding the `awarder` role
//! (EstelaEscrow, EstelaStamps and the Estela backend).

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, String, Symbol, Vec,
};
use stellar_access::access_control::{set_admin, AccessControl};
use stellar_macros::only_role;
use stellar_tokens::non_fungible::{Base, Compose, NonFungibleToken};

const DAY: u32 = 17_280; // ledgers per day, approx. (5 s per ledger)
const TTL_THRESHOLD: u32 = DAY;
const TTL_EXTEND_TO: u32 = 7 * DAY;

/// XP needed for each level, and the discount (basis points) it unlocks.
const VOYAGER_XP: u32 = 500;
const GLOBETROTTER_XP: u32 = 2_000;
const LEGEND_XP: u32 = 5_000;

#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Level {
    Explorer,
    Voyager,
    Globetrotter,
    Legend,
}

impl Level {
    fn from_xp(xp: u32) -> Level {
        if xp >= LEGEND_XP {
            Level::Legend
        } else if xp >= GLOBETROTTER_XP {
            Level::Globetrotter
        } else if xp >= VOYAGER_XP {
            Level::Voyager
        } else {
            Level::Explorer
        }
    }

    fn discount_bps(self) -> u32 {
        match self {
            Level::Explorer => 0,
            Level::Voyager => 500,
            Level::Globetrotter => 1_000,
            Level::Legend => 1_500,
        }
    }
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Xp(Address),
    Pass(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    Soulbound = 1,
}

/// Emitted whenever a member's XP changes, so the backend can follow levels.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct XpChanged {
    #[topic]
    pub user: Address,
    pub xp: u32,
    pub level: Level,
}

#[contract]
pub struct EstelaPass;

#[contractimpl]
impl EstelaPass {
    /// `uri` is the metadata base URI: token N resolves to `{uri}{N}`, served by the
    /// backend with the holder's current level.
    pub fn __constructor(e: &Env, admin: Address, uri: String) {
        set_admin(e, &admin);
        Base::set_metadata(
            e,
            uri,
            String::from_str(e, "Estela Pass"),
            String::from_str(e, "EPASS"),
        );
    }

    /// Adds XP to `user`, minting their pass first if they don't have one yet.
    #[only_role(caller, "awarder")]
    pub fn add_xp(e: &Env, user: Address, xp: u32, caller: Address) {
        if Self::pass_of(e, user.clone()).is_none() {
            let token = <Self as NonFungibleToken>::ContractType::mint(e, &user);
            Self::store(e, &DataKey::Pass(user.clone()), &token);
        }
        let total = Self::xp_of(e, user.clone()).saturating_add(xp);
        Self::set_xp(e, &user, total);
    }

    /// Takes XP back, e.g. when a booking that already earned XP is refunded.
    #[only_role(caller, "awarder")]
    pub fn remove_xp(e: &Env, user: Address, xp: u32, caller: Address) {
        let total = Self::xp_of(e, user.clone()).saturating_sub(xp);
        Self::set_xp(e, &user, total);
    }

    pub fn xp_of(e: &Env, user: Address) -> u32 {
        Self::read(e, &DataKey::Xp(user)).unwrap_or(0)
    }

    pub fn level_of(e: &Env, user: Address) -> Level {
        Level::from_xp(Self::xp_of(e, user))
    }

    /// The discount the member's level unlocks, in basis points (500 = 5 %).
    pub fn discount_bps_of(e: &Env, user: Address) -> u32 {
        Self::level_of(e, user).discount_bps()
    }

    /// The member's pass token id, if they have one.
    pub fn pass_of(e: &Env, user: Address) -> Option<u32> {
        Self::read(e, &DataKey::Pass(user))
    }
}

impl EstelaPass {
    fn set_xp(e: &Env, user: &Address, xp: u32) {
        Self::store(e, &DataKey::Xp(user.clone()), &xp);
        XpChanged {
            user: user.clone(),
            xp,
            level: Level::from_xp(xp),
        }
        .publish(e);
    }

    fn read(e: &Env, key: &DataKey) -> Option<u32> {
        let value = e.storage().persistent().get(key);
        if value.is_some() {
            e.storage()
                .persistent()
                .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
        }
        value
    }

    fn store(e: &Env, key: &DataKey, value: &u32) {
        e.storage().persistent().set(key, value);
        e.storage()
            .persistent()
            .extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
    }
}

#[contractimpl(contracttrait)]
impl NonFungibleToken for EstelaPass {
    type ContractType = Compose<(Base,)>;

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
impl AccessControl for EstelaPass {}

mod test;
