// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for `pay_principal`: principal-only payments that lower the balance
//! without being treated as the next scheduled installment.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, token::TokenClient, BytesN, Env};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 10_000 * UNIT;

/// An approved, disbursed 10,000 loan with a repayment schedule and a funded
/// borrower. `seed` makes the loan id unique.
fn scheduled_loan(env: &Env, pool: &Pool<'_>, seed: u8) -> (Address, BytesN<32>) {
    let investor = funded(env, pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);

    let borrower = funded(env, pool, 200_000 * UNIT);
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &PRINCIPAL);
    (borrower, loan_id)
}

#[test]
fn test_partial_payment_lowers_balance_and_keeps_schedule() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);
    let token = TokenClient::new(&env, &pool.token);

    let sched_before = pool.client.get_repayment_schedule(&loan_id).unwrap();
    let debt_before = pool.client.get_loan_info(&loan_id).outstanding_debt;
    let balance_before = token.balance(&borrower);
    let liquidity_before = pool.client.get_liquidity();

    // Far larger than the monthly installment — a scheduled payment this size
    // would advance the due date.
    let amount = 4_000 * UNIT;
    assert!(amount > sched_before.monthly_amount);
    pool.client.pay_principal(&borrower, &loan_id, &amount);

    let loan = pool.client.get_loan_info(&loan_id);
    assert_eq!(loan.outstanding_debt, debt_before - amount);
    assert_eq!(loan.repaid, amount);
    assert_eq!(loan.status, LoanStatus::Approved);

    // Due date, installment and counters are untouched.
    assert_eq!(
        pool.client.get_repayment_schedule(&loan_id).unwrap(),
        sched_before
    );

    assert_eq!(token.balance(&borrower), balance_before - amount);
    assert_eq!(pool.client.get_liquidity(), liquidity_before + amount);

    // Distinct event; not a scheduled `repay`.
    assert!(has_event(&env, "principal_paid"));
    assert!(!has_event(&env, "repay"));
}

#[test]
fn test_repeated_payments_never_move_the_due_date() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);
    let sched_before = pool.client.get_repayment_schedule(&loan_id).unwrap();

    pool.client
        .pay_principal(&borrower, &loan_id, &(1_000 * UNIT));
    pool.client
        .pay_principal(&borrower, &loan_id, &(2_000 * UNIT));

    assert_eq!(
        pool.client.get_repayment_schedule(&loan_id).unwrap(),
        sched_before
    );
    assert_eq!(pool.client.get_loan_info(&loan_id).repaid, 3_000 * UNIT);
}

#[test]
fn test_interest_accrues_on_the_lower_balance() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);
    // A second, identical loan left untouched as the control.
    let (control_borrower, control_id) = scheduled_loan(&env, &pool, 8);

    pool.client
        .pay_principal(&borrower, &loan_id, &(5_000 * UNIT));

    // Let interest compound, then touch both loans so each accrues.
    env.ledger().set_sequence_number(10_000);
    pool.client.pay_principal(&borrower, &loan_id, &UNIT);
    pool.client
        .pay_principal(&control_borrower, &control_id, &UNIT);
    let lowered = pool.client.get_loan_info(&loan_id);
    let control = pool.client.get_loan_info(&control_id);

    // Same elapsed time and rate, so any difference in accrued interest comes
    // from the lower balance. Interest owed = debt minus unpaid principal.
    let interest_lowered = lowered.outstanding_debt - (lowered.principal - lowered.repaid);
    let interest_control = control.outstanding_debt - (control.principal - control.repaid);
    assert!(interest_lowered > 0);
    assert!(interest_lowered < interest_control);
}

#[test]
fn test_payment_that_clears_the_balance() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);

    // No ledgers have elapsed, so no interest has accrued: clearing principal
    // clears the whole debt and closes the loan.
    pool.client.pay_principal(&borrower, &loan_id, &PRINCIPAL);

    let loan = pool.client.get_loan_info(&loan_id);
    assert_eq!(loan.outstanding_debt, 0);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(pool.client.get_borrower_active_loans(&borrower), 0);
    assert!(has_event(&env, "principal_paid"));
}

#[test]
fn test_clearing_principal_leaves_accrued_interest_owed() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);

    env.ledger().set_sequence_number(10_000);
    pool.client.pay_principal(&borrower, &loan_id, &PRINCIPAL);

    // Principal is retired but interest accrued since disbursement is not
    // principal, so the loan stays open for a normal `repay`.
    let loan = pool.client.get_loan_info(&loan_id);
    assert_eq!(loan.status, LoanStatus::Approved);
    assert!(loan.outstanding_debt > 0);

    // Nothing left to pay down as principal.
    let res = pool.client.try_pay_principal(&borrower, &loan_id, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::OverPayment));

    pool.client
        .repay(&borrower, &loan_id, &loan.outstanding_debt);
    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Repaid
    );
}

#[test]
fn test_clearing_the_whole_debt_cannot_dodge_the_prepayment_penalty() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);

    pool.client.pay_principal(&borrower, &loan_id, &PRINCIPAL);

    // Schedule still has installments outstanding, so it was an early close.
    assert_eq!(
        pool.client.get_total_prepayment_penalties(),
        PRINCIPAL * PREPAYMENT_PENALTY_BPS as i128 / BPS_SCALE as i128
    );
    assert!(has_event(&env, "prepay_closed"));
}

#[test]
fn test_overpayment_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);
    let token = TokenClient::new(&env, &pool.token);
    let debt_before = pool.client.get_loan_info(&loan_id).outstanding_debt;
    let balance_before = token.balance(&borrower);

    let res = pool
        .client
        .try_pay_principal(&borrower, &loan_id, &(PRINCIPAL + 1));
    assert_eq!(res.unwrap_err(), Ok(PoolError::OverPayment));

    // Principal already paid down lowers the ceiling.
    pool.client
        .pay_principal(&borrower, &loan_id, &(6_000 * UNIT));
    let res = pool
        .client
        .try_pay_principal(&borrower, &loan_id, &(4_000 * UNIT + 1));
    assert_eq!(res.unwrap_err(), Ok(PoolError::OverPayment));

    // Nothing was taken by the rejected calls.
    assert_eq!(
        pool.client.get_loan_info(&loan_id).outstanding_debt,
        debt_before - 6_000 * UNIT
    );
    assert_eq!(token.balance(&borrower), balance_before - 6_000 * UNIT);
}

#[test]
fn test_non_positive_amount_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);

    for bad in [0i128, -1] {
        let res = pool.client.try_pay_principal(&borrower, &loan_id, &bad);
        assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    }
}

#[test]
fn test_inactive_loan_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);

    // Requested but never approved.
    let borrower = funded(&env, &pool, 50_000 * UNIT);
    let pending_id = BytesN::from_array(&env, &[1u8; 32]);
    pool.client
        .request_loan(&borrower, &pending_id, &PRINCIPAL);
    let res = pool
        .client
        .try_pay_principal(&borrower, &pending_id, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidLoanState));

    // Already repaid.
    let (payer, loan_id) = scheduled_loan(&env, &pool, 7);
    pool.client.pay_principal(&payer, &loan_id, &PRINCIPAL);
    let res = pool.client.try_pay_principal(&payer, &loan_id, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidLoanState));

    // Unknown loan.
    let missing = BytesN::from_array(&env, &[99u8; 32]);
    let res = pool.client.try_pay_principal(&payer, &missing, &UNIT);
    assert_eq!(res.unwrap_err(), Ok(PoolError::LoanNotFound));
}

#[test]
fn test_live_payoff_quote_is_invalidated() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = scheduled_loan(&env, &pool, 7);

    pool.client.set_payoff_quote_window(&1_000u32);
    pool.client.quote_payoff(&loan_id);
    assert!(pool.client.get_payoff_quote(&loan_id).is_some());

    pool.client
        .pay_principal(&borrower, &loan_id, &(1_000 * UNIT));
    assert!(pool.client.get_payoff_quote(&loan_id).is_none());
}
