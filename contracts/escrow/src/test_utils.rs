// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::Env;
use soroban_sdk::testutils::Ledger as _;

/// Advances the env.ledger().sequence() by `count`.
pub fn advance_ledger_sequence(env: &Env, count: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += count;
    });
}

/// Advances the env.ledger().timestamp() by `seconds`.
pub fn advance_ledger_time(env: &Env, seconds: u64) {
    env.ledger().with_mut(|li| {
        li.timestamp += seconds;
    });
}

use soroban_sdk::{contract, contractimpl, Address};

#[contract]
pub struct MockYieldVault;

#[contractimpl]
impl MockYieldVault {
    pub fn deposit(_env: Env, _from: Address, amount: i128) -> i128 {
        amount
    }

    pub fn withdraw(_env: Env, _from: Address, shares: i128) -> i128 {
        // simulate 10% yield
        shares + (shares / 10)
    }
}
