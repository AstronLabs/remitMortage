// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Storage key collision test for the `staking-pool` contract.
//!
//! Lists every storage key variant and fails if two of them serialize to the
//! same key, or if a variant is added to a key enum without being listed here.
//! See `storage_key_check.rs` (workspace `contracts/` directory) for the checks.

#![cfg(test)]
#![allow(unused_imports, unused_variables)]

use crate::storage_key_check::{assert_storage_keys, key_cases};
use crate::DataKey;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Symbol};

#[test]
fn test_storage_keys_do_not_collide() {
    let env = Env::default();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let sym = Symbol::new(&env, "sample");
    let id = BytesN::from_array(&env, &[7u8; 32]);

    let cases = key_cases!(&env, DataKey;
        Admin,
        SupportedTokens,
        TotalShares,
        Shares(a.clone()),
        StakeBalance(a.clone(), b.clone()),
        RewardIndex(a.clone()),
        LastRewardLedger(a.clone()),
    );

    assert_storage_keys("staking-pool", &[("DataKey", include_str!("lib.rs"))], &cases);
}
