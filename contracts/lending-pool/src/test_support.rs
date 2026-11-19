// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Shared fixtures for the deposit-cap, late-fee-cap and yield-mode tests.

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    Address, Env, Symbol, TryFromVal,
};

/// `mark_default` calls `<escrow>.seize_collateral(...)` for real, so a pool
/// needs a real contract registered at its escrow address.
#[contract]
pub struct SupportEscrow;

#[contractimpl]
impl SupportEscrow {
    pub fn seize_collateral(_env: Env, _borrower: Address, _lending_pool_address: Address) -> i128 {
        0
    }
}

pub struct Pool<'a> {
    pub admin: Address,
    pub token: Address,
    pub client: LendingPoolContractClient<'a>,
}

/// An initialised pool (8% rate, 4% senior rate) with long-lived storage so
/// tests can fast-forward the ledger.
pub fn setup(env: &Env) -> Pool<'_> {
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 4_000_001;
        li.min_persistent_entry_ttl = 4_000_000;
    });

    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let escrow = env.register(SupportEscrow, ());

    let client = LendingPoolContractClient::new(env, &env.register(LendingPoolContract, ()));
    client.initialize(
        &admin, &token, &escrow, &800u32, &400u32, &treasury, &0u32, &0u32,
    );
    Pool {
        admin,
        token,
        client,
    }
}

/// A fresh address holding `amount` of the pool token.
pub fn funded(env: &Env, pool: &Pool<'_>, amount: i128) -> Address {
    let who = Address::generate(env);
    StellarAssetClient::new(env, &pool.token).mint(&who, &amount);
    who
}

/// Whether any event emitted so far has `name` as its first topic.
pub fn has_event(env: &Env, name: &str) -> bool {
    let wanted = Symbol::new(env, name);
    env.events().all().iter().any(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|t| Symbol::try_from_val(env, &t).ok())
            .map_or(false, |s| s == wanted)
    })
}
