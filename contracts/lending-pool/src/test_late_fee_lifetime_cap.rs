// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the cap on a loan's cumulative late fees, as a share of that
//! loan's original principal.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, BytesN, Env};

const UNIT: i128 = 1_0000000;

struct Loan {
    borrower: Address,
    loan_id: BytesN<32>,
    installment: i128,
}

/// An approved, disbursed loan of `principal` with a repayment schedule and a
/// well-funded borrower.
fn scheduled_loan(env: &Env, pool: &Pool<'_>, seed: u8, principal: i128) -> Loan {
    let investor = funded(env, pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);

    let borrower = funded(env, pool, 200_000 * UNIT);
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    pool.client.request_loan(&borrower, &loan_id, &principal);
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &principal);

    let installment = pool
        .client
        .get_repayment_schedule(&loan_id)
        .unwrap()
        .monthly_amount;
    Loan {
        borrower,
        loan_id,
        installment,
    }
}

/// Moves the ledger to `overdue_ledgers` past the current installment's
/// grace deadline.
fn go_late(env: &Env, pool: &Pool<'_>, loan: &Loan, overdue_ledgers: u32) {
    let sched = pool.client.get_repayment_schedule(&loan.loan_id).unwrap();
    let deadline = sched.next_due_ledger + pool.client.get_grace_period();
    env.ledger().set_sequence_number(deadline + overdue_ledgers);
}

/// Uncapped fee for `days` overdue days (the contract's own arithmetic).
fn fee_for_days(pool: &Pool<'_>, installment: i128, days: i128) -> i128 {
    installment * pool.client.get_daily_penalty_bps() as i128 * days / 10_000
}

/// Asserts that exactly `installment + fee` is the minimum accepted late
/// payment, and pays it.
fn assert_fee_is(pool: &Pool<'_>, loan: &Loan, fee: i128) {
    let res = pool
        .client
        .try_repay(&loan.borrower, &loan.loan_id, &(loan.installment + fee - 1));
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &(loan.installment + fee));
}

fn payments_missed(pool: &Pool<'_>, loan: &Loan) -> u32 {
    pool.client
        .get_repayment_schedule(&loan.loan_id)
        .unwrap()
        .payments_missed
}

#[test]
fn test_fees_accrue_normally_under_the_cap() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);
    // 10% of 10,000 = 1,000 ceiling, far above a ten-day fee.
    pool.client.set_late_fee_lifetime_cap_bps(&1_000);
    assert_eq!(pool.client.get_late_fee_lifetime_cap_bps(), 1_000);

    go_late(&env, &pool, &loan, 950); // 10 overdue days
    let fee = fee_for_days(&pool, loan.installment, 10);
    assert!(fee > 0);
    assert_fee_is(&pool, &loan, fee);
    assert!(!has_event(&env, "fee_ltcp"));
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), fee);

    go_late(&env, &pool, &loan, 450); // 5 overdue days
    let fee2 = fee_for_days(&pool, loan.installment, 5);
    assert_fee_is(&pool, &loan, fee2);
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), fee + fee2);
}

#[test]
fn test_fees_stop_once_the_cap_is_reached() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);
    // 0.05% of 10,000 = a 5-unit ceiling.
    pool.client.set_late_fee_lifetime_cap_bps(&5);
    let ceiling = 5 * UNIT;

    // First late payment: 3 days, below the ceiling, charged in full.
    go_late(&env, &pool, &loan, 200);
    let fee1 = fee_for_days(&pool, loan.installment, 3);
    assert!(fee1 < ceiling);
    assert_fee_is(&pool, &loan, fee1);

    // Second: 10 days would cross the ceiling, so only the room left is
    // charged and cumulative fees land exactly on it.
    go_late(&env, &pool, &loan, 950);
    assert!(fee1 + fee_for_days(&pool, loan.installment, 10) > ceiling);
    assert_fee_is(&pool, &loan, ceiling - fee1);
    assert!(has_event(&env, "fee_ltcp"));
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), ceiling);

    // Third: the cap is reached, so no further fee however late.
    go_late(&env, &pool, &loan, 2_000);
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &loan.installment);
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), ceiling);
}

#[test]
fn test_single_accrual_exceeding_the_cap_is_cut_to_the_cap() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);
    pool.client.set_late_fee_lifetime_cap_bps(&5);
    let ceiling = 5 * UNIT;

    // 40 overdue days in one go: uncapped fee far above the ceiling.
    go_late(&env, &pool, &loan, 3_900);
    assert!(fee_for_days(&pool, loan.installment, 40) > ceiling);
    assert_fee_is(&pool, &loan, ceiling);
    assert!(has_event(&env, "fee_ltcp"));
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), ceiling);
}

#[test]
fn test_delinquency_tracking_continues_after_the_cap() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);
    pool.client.set_late_fee_lifetime_cap_bps(&5);

    go_late(&env, &pool, &loan, 3_900);
    assert_fee_is(&pool, &loan, 5 * UNIT);
    assert_eq!(payments_missed(&pool, &loan), 1);

    // Fee-free now, but each late payment is still recorded as missed.
    go_late(&env, &pool, &loan, 3_900);
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &loan.installment);
    assert_eq!(payments_missed(&pool, &loan), 2);

    go_late(&env, &pool, &loan, 3_900);
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &loan.installment);
    assert_eq!(payments_missed(&pool, &loan), 3);

    // An on-time payment still resets the streak as normal.
    let sched = pool.client.get_repayment_schedule(&loan.loan_id).unwrap();
    env.ledger().set_sequence_number(sched.next_due_ledger);
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &loan.installment);
    assert_eq!(payments_missed(&pool, &loan), 0);
}

#[test]
fn test_cap_is_per_loan_from_its_own_original_principal() {
    let env = Env::default();
    let pool = setup(&env);
    let big = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);
    let small = scheduled_loan(&env, &pool, 2, 5_000 * UNIT);
    // 0.1%: 10 units on the 10,000 loan, 5 units on the 5,000 loan.
    pool.client.set_late_fee_lifetime_cap_bps(&10);

    go_late(&env, &pool, &big, 3_900);
    assert_fee_is(&pool, &big, 10 * UNIT);
    go_late(&env, &pool, &small, 3_900);
    assert_fee_is(&pool, &small, 5 * UNIT);

    assert_eq!(pool.client.get_loan_late_fees(&big.loan_id), 10 * UNIT);
    assert_eq!(pool.client.get_loan_late_fees(&small.loan_id), 5 * UNIT);
    assert_eq!(
        pool.client
            .get_loan_origin_terms(&small.loan_id)
            .original_principal,
        5_000 * UNIT
    );
}

#[test]
fn test_fees_charged_before_the_cap_was_enabled_count_toward_it() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);

    go_late(&env, &pool, &loan, 200);
    let fee1 = fee_for_days(&pool, loan.installment, 3);
    assert_fee_is(&pool, &loan, fee1);
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), fee1);

    pool.client.set_late_fee_lifetime_cap_bps(&5);
    go_late(&env, &pool, &loan, 3_900);
    assert_fee_is(&pool, &loan, 5 * UNIT - fee1);
    assert_eq!(pool.client.get_loan_late_fees(&loan.loan_id), 5 * UNIT);
}

#[test]
fn test_no_cap_by_default_and_fee_unchanged() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool, 1, 10_000 * UNIT);
    assert_eq!(pool.client.get_late_fee_lifetime_cap_bps(), 0);

    go_late(&env, &pool, &loan, 3_900);
    let fee = fee_for_days(&pool, loan.installment, 40);
    assert_fee_is(&pool, &loan, fee);
    assert!(!has_event(&env, "fee_ltcp"));
}

#[test]
fn test_set_cap_validation() {
    let env = Env::default();
    let pool = setup(&env);
    let res = pool.client.try_set_late_fee_lifetime_cap_bps(&10_001);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    pool.client.set_late_fee_lifetime_cap_bps(&10_000);
    assert_eq!(pool.client.get_late_fee_lifetime_cap_bps(), 10_000);
}
