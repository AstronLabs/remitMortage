// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Storage key collision test for the `escrow` contract.
//!
//! Lists every storage key variant and fails if two of them serialize to the
//! same key, or if a variant is added to a key enum without being listed here.
//! See `storage_key_check.rs` (workspace `contracts/` directory) for the checks.

#![cfg(test)]
#![allow(unused_imports, unused_variables)]

use crate::storage_key_check::{assert_storage_keys, key_cases};
use crate::types::DataKey;
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Symbol};

#[test]
fn test_storage_keys_do_not_collide() {
    let env = Env::default();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let sym = Symbol::new(&env, "sample");
    let id = BytesN::from_array(&env, &[7u8; 32]);

    let cases = key_cases!(&env, DataKey;
        Config,
        Borrower(a.clone(), sym.clone()),
        TotalPooled,
        MatchingReserve,
        TotalYieldShares,
        Version,
        PendingUpgrade,
        PendingPenaltyTiers,
        UpgradeDelay,
        Paused,
        PendingAdmin,
        LendingPool,
        Beneficiary(a.clone(), sym.clone()),
        BeneficiaryList(a.clone(), sym.clone()),
        LastOwnerActivity(a.clone(), sym.clone()),
        BeneficiaryClaimed(a.clone(), sym.clone()),
        BeneficiaryInactivityPeriod,
        BeneficiaryAttestors,
        YieldShares(a.clone(), sym.clone()),
        ReentrancyGuard,
        Whitelist(a.clone()),
        AutoDeposit(a.clone(), sym.clone()),
        PendingAttestorChange,
        AttestorChangeDelay,
        HardshipRequest(a.clone(), sym.clone()),
        HardshipApprovalWindowLedgers,
        HardshipCapPerPeriod,
        HardshipPeriodLedgers,
        HardshipWithdrawnInPeriod(a.clone(), sym.clone(), 7u32),
        ReleaseSchedule(a.clone(), sym.clone()),
        PendingReleaseTime(a.clone(), sym.clone()),
        ReleaseScheduleLimits,
    );

    assert_storage_keys("escrow", &[("DataKey", include_str!("types.rs"))], &cases);
}
