// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

fn activate_curve(env: &Env, client: &LendingPoolContractClient<'_>, curve: &BorrowRateCurve) {
    // First call queues the timelocked proposal.
    client.set_borrow_rate_curve(curve);
    assert!(client.get_pending_rate_curve().is_some());

    // Calling before timelock elapses fails with TimelockActive.
    let early = client.try_set_borrow_rate_curve(curve);
    assert_eq!(early, Err(Ok(PoolError::TimelockActive)));

    // Advance past delay and execute.
    env.ledger().with_mut(|li| {
        li.sequence_number += MIN_CAP_CHANGE_DELAY_LEDGERS + 1;
    });
    client.set_borrow_rate_curve(curve);
    assert_eq!(client.get_borrow_rate_curve(), Some(curve.clone()));
}

#[test]
fn kinked_rate_curve_prices_zero_kink_and_full_utilization_and_preserves_existing_loans() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    let investor = funded(&env, &pool, 100_000);
    client.deposit(&investor, &100_000, &Tranche::Senior);

    // Originate an existing loan under the initial flat 800 bps rate.
    let borrower1 = funded(&env, &pool, 50_000);
    let existing_loan = BytesN::from_array(&env, &[10u8; 32]);
    client.request_loan(&borrower1, &existing_loan, &20_000);
    assert_eq!(client.get_loan_info(&existing_loan).interest_rate_bps, 800);

    // Configure kinked curve: base=400, opt=8000 (80%), slope1=400, slope2=1200, floor=200, cap=2500.
    // 0% util -> 400 bps
    // 80% util (kink) -> 400 + 400 = 800 bps
    // 90% util -> 800 + (1000/2000)*1200 = 1400 bps
    // 100% util -> 800 + 1200 = 2000 bps
    let curve = BorrowRateCurve {
        base_rate_bps: 400,
        optimal_utilization_bps: 8_000,
        slope1_bps: 400,
        slope2_bps: 1_200,
        min_rate_bps: 200,
        max_rate_bps: 2_500,
    };
    activate_curve(&env, client, &curve);

    assert_eq!(client.borrow_rate_for_utilization(&0), 400);
    assert_eq!(client.borrow_rate_for_utilization(&4_000), 600);
    assert_eq!(client.borrow_rate_for_utilization(&8_000), 800);
    assert_eq!(client.borrow_rate_for_utilization(&9_000), 1_400);
    assert_eq!(client.borrow_rate_for_utilization(&10_000), 2_000);

    // Existing loan keeps its agreed 800 bps rate.
    assert_eq!(client.get_loan_info(&existing_loan).interest_rate_bps, 800);

    // At 0% utilization (loan 1 not yet approved/disbursed), a new loan gets 400 bps.
    let borrower2 = funded(&env, &pool, 50_000);
    let low_util_loan = BytesN::from_array(&env, &[11u8; 32]);
    client.request_loan(&borrower2, &low_util_loan, &10_000);
    assert_eq!(client.get_loan_info(&low_util_loan).interest_rate_bps, 400);

    // Approve & disburse 90_000 so utilization rises to 90% (above the 80% kink).
    let contractor = Address::generate(&env);
    client.add_contractor(&contractor);
    let big_loan = BytesN::from_array(&env, &[12u8; 32]);
    client.request_loan(&borrower2, &big_loan, &90_000);
    client.approve_loan(&big_loan);
    client.disburse(&big_loan, &contractor, &90_000);
    assert_eq!(client.get_utilization(), 9_000);

    // A new loan originated at 90% utilization gets 1400 bps (steep post-kink slope).
    let high_util_loan = BytesN::from_array(&env, &[13u8; 32]);
    client.request_loan(&borrower2, &high_util_loan, &1_000);
    assert_eq!(client.get_loan_info(&high_util_loan).interest_rate_bps, 1_400);

    // Existing loan is still unaffected.
    assert_eq!(client.get_loan_info(&existing_loan).interest_rate_bps, 800);
}

#[test]
fn zero_slope_curve_preserves_flat_rate_and_clamps_to_floor_and_cap() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    let flat_curve = BorrowRateCurve {
        base_rate_bps: 750,
        optimal_utilization_bps: 8_000,
        slope1_bps: 0,
        slope2_bps: 0,
        min_rate_bps: 200,
        max_rate_bps: 5_000,
    };
    activate_curve(&env, client, &flat_curve);

    assert_eq!(client.borrow_rate_for_utilization(&0), 750);
    assert_eq!(client.borrow_rate_for_utilization(&8_000), 750);
    assert_eq!(client.borrow_rate_for_utilization(&10_000), 750);

    // Cap & floor clamping test
    let clamped_curve = BorrowRateCurve {
        base_rate_bps: 100, // below floor 300
        optimal_utilization_bps: 5_000,
        slope1_bps: 500,
        slope2_bps: 3_000, // pushes 100% util to 3600 > cap 1500
        min_rate_bps: 300,
        max_rate_bps: 1_500,
    };
    activate_curve(&env, client, &clamped_curve);

    assert_eq!(client.borrow_rate_for_utilization(&0), 300);
    assert_eq!(client.borrow_rate_for_utilization(&10_000), 1_500);
}
