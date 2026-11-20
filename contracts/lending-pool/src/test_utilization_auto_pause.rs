// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn loan_id(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn origination_allowed_just_under_threshold_and_refused_at_and_over_threshold() {
    let env = Env::default();
    let pool = setup(&env);
    let inv = funded(&env, &pool, 100_000_0000000i128);
    pool.client
        .deposit(&inv, &100_000_0000000i128, &Tranche::Senior);

    // Invalid threshold > 10_000 bps is rejected.
    assert_eq!(
        pool.client.try_set_utilization_pause_threshold(&10_001u32),
        Err(Ok(PoolError::InvalidAmount))
    );

    // Configure an 80% (8_000 bps) utilization safety threshold.
    pool.client.set_utilization_pause_threshold(&8_000u32);
    assert_eq!(pool.client.get_utilization_pause_threshold(), 8_000u32);
    assert!(!pool.client.is_utilization_auto_paused());

    let borrower = Address::generate(&env);

    // Originate 79_990 (7_999 bps = just under the 8_000 bps threshold).
    let l1 = loan_id(&env, 0x01);
    pool.client
        .request_loan(&borrower, &l1, &79_990_0000000i128);
    pool.client.approve_loan(&l1);
    assert_eq!(pool.client.get_utilization(), 7_999u32);
    assert!(!pool.client.is_utilization_auto_paused());

    // While still strictly under threshold, another origination is allowed.
    let l2 = loan_id(&env, 0x02);
    pool.client.request_loan(&borrower, &l2, &10_0000000i128);
    pool.client.approve_loan(&l2);

    // Reaching exactly 8_000 bps (at the threshold) activates auto-pause.
    assert_eq!(pool.client.get_utilization(), 8_000u32);
    assert!(pool.client.is_utilization_auto_paused());

    // Further loan originations are automatically refused.
    let l3 = loan_id(&env, 0x03);
    assert_eq!(
        pool.client
            .try_request_loan(&borrower, &l3, &1_000_0000000i128),
        Err(Ok(PoolError::ContractPaused))
    );

    // Verify the "just over threshold" case (8_001 bps) on a fresh pool.
    let env2 = Env::default();
    let pool2 = setup(&env2);
    let inv2 = funded(&env2, &pool2, 100_000_0000000i128);
    pool2
        .client
        .deposit(&inv2, &100_000_0000000i128, &Tranche::Senior);
    pool2.client.set_utilization_pause_threshold(&8_000u32);

    let b2 = Address::generate(&env2);
    let over_loan = loan_id(&env2, 0x11);
    pool2
        .client
        .request_loan(&b2, &over_loan, &80_010_0000000i128);
    pool2.client.approve_loan(&over_loan);
    assert_eq!(pool2.client.get_utilization(), 8_001u32);
    assert!(pool2.client.is_utilization_auto_paused());

    let blocked = loan_id(&env2, 0x12);
    assert_eq!(
        pool2
            .client
            .try_request_loan(&b2, &blocked, &500_0000000i128),
        Err(Ok(PoolError::ContractPaused))
    );
}

#[test]
fn withdrawals_and_repayments_work_while_auto_paused_and_auto_clears_below_threshold() {
    let env = Env::default();
    let pool = setup(&env);
    let inv = funded(&env, &pool, 100_000_0000000i128);
    pool.client
        .deposit(&inv, &100_000_0000000i128, &Tranche::Senior);
    pool.client.set_utilization_pause_threshold(&8_000u32);

    let borrower = Address::generate(&env);
    let l1 = loan_id(&env, 0x21);
    pool.client
        .request_loan(&borrower, &l1, &80_000_0000000i128);
    pool.client.approve_loan(&l1);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&l1, &borrower, &80_000_0000000i128);

    assert!(pool.client.is_utilization_auto_paused());

    // Origination is blocked while auto-paused.
    let blocked = loan_id(&env, 0x22);
    assert_eq!(
        pool.client
            .try_request_loan(&borrower, &blocked, &1_000_0000000i128),
        Err(Ok(PoolError::ContractPaused))
    );

    // Withdrawals remain unblocked while utilization auto-pause is active.
    pool.client.withdraw(&inv, &5_000_0000000i128);
    assert!(pool.client.is_utilization_auto_paused());

    // Repayments remain unblocked and automatically clear the auto-pause once
    // utilization falls back below the 8_000 bps threshold.
    pool.client.repay(&borrower, &l1, &20_000_0000000i128);
    assert!(pool.client.get_utilization() < 8_000u32);
    assert!(!pool.client.is_utilization_auto_paused());

    // New origination succeeds again once utilization is below threshold.
    pool.client
        .request_loan(&borrower, &blocked, &1_000_0000000i128);
}

#[test]
fn admin_can_manually_lift_utilization_auto_pause() {
    let env = Env::default();
    let pool = setup(&env);
    let inv = funded(&env, &pool, 100_000_0000000i128);
    pool.client
        .deposit(&inv, &100_000_0000000i128, &Tranche::Senior);
    pool.client.set_utilization_pause_threshold(&8_000u32);

    let borrower = Address::generate(&env);
    let l1 = loan_id(&env, 0x31);
    pool.client
        .request_loan(&borrower, &l1, &80_000_0000000i128);
    pool.client.approve_loan(&l1);
    assert!(pool.client.is_utilization_auto_paused());

    let l2 = loan_id(&env, 0x32);
    assert_eq!(
        pool.client
            .try_request_loan(&borrower, &l2, &1_000_0000000i128),
        Err(Ok(PoolError::ContractPaused))
    );

    // Admin manually lifts the auto-pause.
    pool.client.clear_utilization_auto_pause();
    assert!(!pool.client.is_utilization_auto_paused());

    // Origination is permitted again after the manual lift.
    pool.client.request_loan(&borrower, &l2, &1_000_0000000i128);
}
