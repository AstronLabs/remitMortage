// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the per-period cap on accumulated late fees.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, token::TokenClient, BytesN, Env};

const UNIT: i128 = 1_0000000;

struct Loan {
    borrower: Address,
    loan_id: BytesN<32>,
    sched: RepaymentSchedule,
    /// Ledger after which a payment is charged a late fee.
    deadline: u32,
}

/// An approved, disbursed 10,000 loan with a repayment schedule and a funded
/// borrower.
fn scheduled_loan(env: &Env, pool: &Pool<'_>) -> Loan {
    let investor = funded(env, pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);

    let borrower = funded(env, pool, 200_000 * UNIT);
    let loan_id = BytesN::from_array(env, &[7u8; 32]);
    pool.client
        .request_loan(&borrower, &loan_id, &(10_000 * UNIT));
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &(10_000 * UNIT));

    let sched = pool.client.get_repayment_schedule(&loan_id).unwrap();
    let deadline = sched.next_due_ledger + pool.client.get_grace_period();
    Loan {
        borrower,
        loan_id,
        sched,
        deadline,
    }
}

/// The fee for `days` overdue days at the pool's daily rate (the same integer
/// arithmetic the contract uses).
fn fee_for_days(pool: &Pool<'_>, installment: i128, days: i128) -> i128 {
    installment * pool.client.get_daily_penalty_bps() as i128 * days / 10_000
}

/// Asserts that exactly `installment + fee` is the minimum accepted payment.
fn assert_fee_is(pool: &Pool<'_>, loan: &Loan, fee: i128) {
    let installment = loan.sched.monthly_amount;
    let res = pool
        .client
        .try_repay(&loan.borrower, &loan.loan_id, &(installment + fee - 1));
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &(installment + fee));
}

// ── Zero setting preserves current behaviour ────────────────────────────

#[test]
fn test_no_cap_by_default_and_fee_is_unchanged() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    assert_eq!(pool.client.get_late_fee_cap(), (0, 0));

    // 40 overdue days: the fee keeps growing linearly with no ceiling.
    env.ledger().set_sequence_number(loan.deadline + 3_900);
    let fee = fee_for_days(&pool, loan.sched.monthly_amount, 40);
    assert_fee_is(&pool, &loan, fee);
    assert!(!has_event(&env, "fee_capd"));
}

#[test]
fn test_explicit_zero_cap_preserves_behaviour() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    pool.client.set_late_fee_cap(&0, &0);

    env.ledger().set_sequence_number(loan.deadline + 3_900);
    let fee = fee_for_days(&pool, loan.sched.monthly_amount, 40);
    assert_fee_is(&pool, &loan, fee);
    assert!(!has_event(&env, "fee_capd"));
}

// ── Exact boundary ──────────────────────────────────────────────────────

#[test]
fn test_fee_exactly_at_cap_is_not_reduced() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    // The cap is three days' worth of fee.
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    // 200 ledgers past the deadline = 3 overdue days (rounded up): fee == cap.
    env.ledger().set_sequence_number(loan.deadline + 200);
    assert_fee_is(&pool, &loan, cap);
    assert!(!has_event(&env, "fee_capd"), "nothing was reduced");
}

#[test]
fn test_fee_one_day_over_cap_stops_at_cap() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    // 4 overdue days would cost more than the cap.
    env.ledger().set_sequence_number(loan.deadline + 300);
    assert!(fee_for_days(&pool, installment, 4) > cap);
    assert_fee_is(&pool, &loan, cap);
}

#[test]
fn test_fee_below_cap_is_untouched() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    pool.client
        .set_late_fee_cap(&fee_for_days(&pool, installment, 10), &0);

    // 2 overdue days.
    env.ledger().set_sequence_number(loan.deadline + 100);
    assert_fee_is(&pool, &loan, fee_for_days(&pool, installment, 2));
    assert!(!has_event(&env, "fee_capd"));
}

// ── Percentage cap and combining limits ─────────────────────────────────

#[test]
fn test_percentage_cap_of_installment() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;

    // 0.3% of the installment == three days at the default 10 bps/day.
    pool.client.set_late_fee_cap(&0, &30);
    env.ledger().set_sequence_number(loan.deadline + 3_900);
    assert_fee_is(&pool, &loan, installment * 30 / 10_000);
}

#[test]
fn test_lower_of_absolute_and_percentage_applies() {
    let env = Env::default();
    let pool = setup(&env);
    let installment = scheduled_loan(&env, &pool).sched.monthly_amount;
    let pct_cap = installment * 30 / 10_000;

    // Absolute limb larger than the percentage limb: the percentage wins.
    pool.client.set_late_fee_cap(&(pct_cap * 10), &30);
    let loan = scheduled_loan_again(&env, &pool);
    env.ledger().set_sequence_number(loan.deadline + 3_900);
    assert_fee_is(&pool, &loan, pct_cap);
}

#[test]
fn test_absolute_cap_wins_when_lower_than_percentage() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let abs_cap = installment * 10 / 10_000; // one day's fee
    pool.client.set_late_fee_cap(&abs_cap, &500);
    env.ledger().set_sequence_number(loan.deadline + 3_900);
    assert_fee_is(&pool, &loan, abs_cap);
}

/// A second loan for tests that need the installment before configuring.
fn scheduled_loan_again(env: &Env, pool: &Pool<'_>) -> Loan {
    let borrower = funded(env, pool, 200_000 * UNIT);
    let loan_id = BytesN::from_array(env, &[9u8; 32]);
    pool.client
        .request_loan(&borrower, &loan_id, &(10_000 * UNIT));
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &(10_000 * UNIT));
    let sched = pool.client.get_repayment_schedule(&loan_id).unwrap();
    let deadline = sched.next_due_ledger + pool.client.get_grace_period();
    Loan {
        borrower,
        loan_id,
        sched,
        deadline,
    }
}

// ── Multiple missed payments / periods ──────────────────────────────────

#[test]
fn test_fee_stops_at_cap_however_late_within_one_period() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    // Almost a full month late, still inside the first billing period.
    env.ledger()
        .set_sequence_number(loan.deadline + LEDGERS_PER_MONTH - 1);
    assert_fee_is(&pool, &loan, cap);
}

#[test]
fn test_each_missed_period_is_capped_separately() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    // One full billing period plus a little: two periods of fees, each at its cap.
    env.ledger()
        .set_sequence_number(loan.deadline + LEDGERS_PER_MONTH + 200);
    assert_fee_is(&pool, &loan, 2 * cap);
    let s = pool.client.get_repayment_schedule(&loan.loan_id).unwrap();
    assert_eq!(s.payments_missed, loan.sched.payments_missed + 2);
}

#[test]
fn test_three_periods_late_pays_three_caps() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    env.ledger()
        .set_sequence_number(loan.deadline + 2 * LEDGERS_PER_MONTH + 200);
    assert_fee_is(&pool, &loan, 3 * cap);
}

// ── Cap reset on the next period ────────────────────────────────────────

#[test]
fn test_cap_resets_for_the_next_period_and_nothing_carries_forward() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    // First late payment, well past the cap: pays exactly one cap.
    env.ledger().set_sequence_number(loan.deadline + 1_000);
    assert_fee_is(&pool, &loan, cap);

    // The schedule moved on. Being late again in the next period starts from
    // zero: the fee is a fresh, small amount — not the cap plus a carried-over
    // remainder.
    let next = pool.client.get_repayment_schedule(&loan.loan_id).unwrap();
    let next_deadline = next.next_due_ledger + pool.client.get_grace_period();
    env.ledger().set_sequence_number(next_deadline + 100);
    // 2 overdue days: below the cap, so it is charged in full and uncapped.
    assert_fee_is(&pool, &loan, fee_for_days(&pool, installment, 2));
}

#[test]
fn test_next_period_is_capped_again() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    env.ledger().set_sequence_number(loan.deadline + 1_000);
    assert_fee_is(&pool, &loan, cap);

    let next = pool.client.get_repayment_schedule(&loan.loan_id).unwrap();
    let next_deadline = next.next_due_ledger + pool.client.get_grace_period();
    env.ledger().set_sequence_number(next_deadline + 1_000);
    assert_fee_is(&pool, &loan, cap);
}

// ── Event ───────────────────────────────────────────────────────────────

#[test]
fn test_event_emitted_when_fee_is_reduced() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    env.ledger().set_sequence_number(loan.deadline + 1_000);
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &(installment + cap));
    assert!(has_event(&env, "fee_capd"));
}

#[test]
fn test_paying_the_capped_fee_moves_the_expected_tokens() {
    let env = Env::default();
    let pool = setup(&env);
    let loan = scheduled_loan(&env, &pool);
    let installment = loan.sched.monthly_amount;
    let cap = fee_for_days(&pool, installment, 3);
    pool.client.set_late_fee_cap(&cap, &0);

    let token = TokenClient::new(&env, &pool.token);
    let before = token.balance(&loan.borrower);
    env.ledger().set_sequence_number(loan.deadline + 1_000);
    pool.client
        .repay(&loan.borrower, &loan.loan_id, &(installment + cap));
    assert_eq!(before - token.balance(&loan.borrower), installment + cap);
}

// ── Configuration ───────────────────────────────────────────────────────

#[test]
fn test_set_and_get_late_fee_cap() {
    let env = Env::default();
    let pool = setup(&env);
    pool.client.set_late_fee_cap(&(5 * UNIT), &250);
    assert!(has_event(&env, "fee_cap"));
    assert_eq!(pool.client.get_late_fee_cap(), (5 * UNIT, 250));

    // 100% of the installment is the largest sensible percentage.
    pool.client.set_late_fee_cap(&0, &10_000);
    assert_eq!(pool.client.get_late_fee_cap(), (0, 10_000));
}

#[test]
fn test_invalid_cap_configuration_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let res = pool.client.try_set_late_fee_cap(&-1, &0);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    let res = pool.client.try_set_late_fee_cap(&0, &10_001);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    assert_eq!(pool.client.get_late_fee_cap(), (0, 0));
}
