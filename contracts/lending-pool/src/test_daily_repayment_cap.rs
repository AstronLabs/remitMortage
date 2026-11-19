// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the per-borrower daily repayment cap (fraud containment).

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, token::TokenClient, BytesN, Env};

const UNIT: i128 = 1_0000000;
const CAP: i128 = 1_000 * UNIT;

/// First ledger of the ledger day these tests start in.
const DAY_START: u32 = 10 * LEDGERS_PER_DAY;

/// An approved, disbursed 10,000 loan and its funded borrower, with the
/// ledger parked at the start of a ledger day.
fn active_loan(env: &Env, pool: &Pool<'_>, seed: u8) -> (Address, BytesN<32>) {
    let investor = funded(env, pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);

    let borrower = funded(env, pool, 50_000 * UNIT);
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    pool.client
        .request_loan(&borrower, &loan_id, &(10_000 * UNIT));
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &(10_000 * UNIT));

    env.ledger().set_sequence_number(DAY_START);
    (borrower, loan_id)
}

fn outstanding(pool: &Pool<'_>, loan_id: &BytesN<32>) -> i128 {
    pool.client.get_loan_info(loan_id).outstanding_debt
}

#[test]
fn test_no_cap_by_default() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    assert_eq!(pool.client.get_daily_repayment_cap(), 0);

    pool.client.repay(&borrower, &loan_id, &(5_000 * UNIT));
    pool.client.repay(&borrower, &loan_id, &(2_000 * UNIT));
    // Nothing is tracked while the cap is disabled.
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), 0);
}

#[test]
fn test_repayments_under_the_cap_are_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);
    assert_eq!(pool.client.get_daily_repayment_cap(), CAP);

    pool.client.repay(&borrower, &loan_id, &(300 * UNIT));
    pool.client.repay(&borrower, &loan_id, &(400 * UNIT));
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), 700 * UNIT);
}

#[test]
fn test_repayments_reaching_exactly_the_cap_are_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);

    pool.client.repay(&borrower, &loan_id, &(600 * UNIT));
    pool.client.repay(&borrower, &loan_id, &(400 * UNIT));
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), CAP);
}

#[test]
fn test_single_repayment_of_exactly_the_cap_is_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);
    pool.client.repay(&borrower, &loan_id, &CAP);
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), CAP);
}

#[test]
fn test_repayment_over_the_cap_is_rejected_outright() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);
    let token = TokenClient::new(&env, &pool.token);

    pool.client.repay(&borrower, &loan_id, &(800 * UNIT));
    let debt_before = outstanding(&pool, &loan_id);
    let balance_before = token.balance(&borrower);

    // 800 + 201 > 1,000: rejected whole, not trimmed down to the 200 left.
    let res = pool.client.try_repay(&borrower, &loan_id, &(201 * UNIT));
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
    assert_eq!(outstanding(&pool, &loan_id), debt_before);
    assert_eq!(token.balance(&borrower), balance_before);
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), 800 * UNIT);

    // The remaining allowance is still usable.
    pool.client.repay(&borrower, &loan_id, &(200 * UNIT));
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), CAP);
}

#[test]
fn test_single_repayment_above_the_cap_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);
    let debt_before = outstanding(&pool, &loan_id);

    let res = pool.client.try_repay(&borrower, &loan_id, &(CAP + 1));
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
    assert_eq!(outstanding(&pool, &loan_id), debt_before);
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), 0);
}

#[test]
fn test_allowance_resets_at_the_next_ledger_day() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);

    pool.client.repay(&borrower, &loan_id, &CAP);

    // Last ledger of the same day: still exhausted.
    env.ledger()
        .set_sequence_number(DAY_START + LEDGERS_PER_DAY - 1);
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), CAP);
    let res = pool.client.try_repay(&borrower, &loan_id, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));

    // First ledger of the next day: the full allowance is back.
    env.ledger()
        .set_sequence_number(DAY_START + LEDGERS_PER_DAY);
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), 0);
    pool.client.repay(&borrower, &loan_id, &CAP);
    assert_eq!(pool.client.get_borrower_daily_repaid(&borrower), CAP);
    let res = pool.client.try_repay(&borrower, &loan_id, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
}

#[test]
fn test_day_boundary_follows_ledger_sequence_not_timestamp() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_daily_repayment_cap(&CAP);
    pool.client.repay(&borrower, &loan_id, &CAP);

    // A full wall-clock day passing without the ledger day changing does
    // not reset the allowance.
    env.ledger()
        .set_timestamp(env.ledger().timestamp() + 2 * 86_400);
    let res = pool.client.try_repay(&borrower, &loan_id, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
}

#[test]
fn test_cap_is_tracked_per_borrower() {
    let env = Env::default();
    let pool = setup(&env);
    let (alice, alice_loan) = active_loan(&env, &pool, 1);
    let (bob, bob_loan) = active_loan(&env, &pool, 2);
    pool.client.set_daily_repayment_cap(&CAP);

    pool.client.repay(&alice, &alice_loan, &CAP);
    assert!(pool.client.try_repay(&alice, &alice_loan, &UNIT).is_err());

    // Alice exhausting her allowance leaves Bob's untouched.
    pool.client.repay(&bob, &bob_loan, &CAP);
    assert_eq!(pool.client.get_borrower_daily_repaid(&bob), CAP);
}

#[test]
fn test_cap_applies_across_a_borrowers_loans() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, first) = active_loan(&env, &pool, 1);
    let second = BytesN::from_array(&env, &[9u8; 32]);
    pool.client
        .request_loan(&borrower, &second, &(5_000 * UNIT));
    pool.client.approve_loan(&second);
    pool.client.disburse(&second, &borrower, &(5_000 * UNIT));
    pool.client.set_daily_repayment_cap(&CAP);

    pool.client.repay(&borrower, &first, &(700 * UNIT));
    let res = pool.client.try_repay(&borrower, &second, &(301 * UNIT));
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
    pool.client.repay(&borrower, &second, &(300 * UNIT));
}

#[test]
fn test_quoted_payoff_counts_against_the_cap() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_payoff_quote_window(&(5 * LEDGERS_PER_DAY));
    pool.client.set_daily_repayment_cap(&CAP);

    let quote = pool.client.quote_payoff(&loan_id);
    assert!(quote > CAP);
    let res = pool
        .client
        .try_payoff_with_quote(&borrower, &loan_id, &quote);
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
    let res = pool.client.try_repay(&borrower, &loan_id, &quote);
    assert_eq!(res.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}

#[test]
fn test_set_cap_validation_and_disable() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);

    let res = pool.client.try_set_daily_repayment_cap(&-1);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));

    pool.client.set_daily_repayment_cap(&CAP);
    pool.client.repay(&borrower, &loan_id, &CAP);
    assert!(pool.client.try_repay(&borrower, &loan_id, &UNIT).is_err());

    // Setting the cap back to zero lifts it immediately.
    pool.client.set_daily_repayment_cap(&0);
    pool.client.repay(&borrower, &loan_id, &UNIT);
}
