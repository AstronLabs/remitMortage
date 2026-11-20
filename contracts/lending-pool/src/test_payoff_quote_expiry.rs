// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the payoff-quote validity window (#1025).
//!
//! A payoff quote is only valid for a fixed, admin-configurable window of
//! ledgers counted from the moment it is generated. A settlement presented
//! inside that window — including exactly on its last valid ledger — is
//! honoured at the quoted amount, while one presented after the window has
//! closed is rejected so a stale quote can never be settled.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, BytesN, Env};

const UNIT: i128 = 1_0000000;

/// Window used by the explicit-configuration tests.
const WINDOW: u32 = 500;

/// An approved, disbursed 10,000 loan and its funded borrower.
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
    (borrower, loan_id)
}

#[test]
fn test_window_is_admin_configurable() {
    let env = Env::default();
    let pool = setup(&env);
    pool.client.set_payoff_quote_window(&WINDOW);
    assert_eq!(pool.client.get_payoff_quote_window(), WINDOW);
}

#[test]
fn test_default_window_allows_quoting_out_of_the_box() {
    let env = Env::default();
    let pool = setup(&env);

    // A freshly deployed pool ships with a positive, usable window.
    assert!(pool.client.get_payoff_quote_window() > 0);

    let (borrower, loan_id) = active_loan(&env, &pool, 2);
    let quoted = pool.client.quote_payoff(&loan_id);
    assert!(quoted > 0);
    pool.client.payoff_with_quote(&borrower, &loan_id, &quoted);
    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Repaid
    );
}

#[test]
fn test_settlement_within_the_window_is_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_payoff_quote_window(&WINDOW);

    let quoted = pool.client.quote_payoff(&loan_id);
    let quote = pool.client.get_payoff_quote(&loan_id).unwrap();
    assert_eq!(quote.quoted_amount, quoted);
    assert_eq!(quote.expires_ledger, quote.quoted_at_ledger + WINDOW);

    // Halfway through the window: the quote is honoured at the quoted amount.
    env.ledger()
        .set_sequence_number(quote.quoted_at_ledger + WINDOW / 2);
    pool.client.payoff_with_quote(&borrower, &loan_id, &quoted);

    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Repaid
    );
    // Using the quote consumes it.
    assert!(pool.client.get_payoff_quote(&loan_id).is_none());
}

#[test]
fn test_settlement_exactly_on_the_window_boundary_is_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_payoff_quote_window(&WINDOW);

    let quoted = pool.client.quote_payoff(&loan_id);
    let quote = pool.client.get_payoff_quote(&loan_id).unwrap();

    // The last ledger on which the quote is still valid is inclusive.
    env.ledger().set_sequence_number(quote.expires_ledger);
    pool.client.payoff_with_quote(&borrower, &loan_id, &quoted);

    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Repaid
    );
}

#[test]
fn test_settlement_past_the_window_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_payoff_quote_window(&WINDOW);

    let quoted = pool.client.quote_payoff(&loan_id);
    let quote = pool.client.get_payoff_quote(&loan_id).unwrap();

    // One ledger past the last valid ledger: the quote is stale.
    env.ledger().set_sequence_number(quote.expires_ledger + 1);
    let res = pool
        .client
        .try_payoff_with_quote(&borrower, &loan_id, &quoted);
    assert_eq!(res.unwrap_err(), Ok(PoolError::PayoffQuoteExpired));

    // The stale quote is pruned and the loan is left open and unsettled.
    assert!(pool.client.get_payoff_quote(&loan_id).is_none());
    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}

#[test]
fn test_expired_quote_is_not_honoured_by_repay() {
    let env = Env::default();
    let pool = setup(&env);
    let (borrower, loan_id) = active_loan(&env, &pool, 1);
    pool.client.set_payoff_quote_window(&WINDOW);

    let quoted = pool.client.quote_payoff(&loan_id);
    let quote = pool.client.get_payoff_quote(&loan_id).unwrap();

    // Past the window, a plain `repay` of the stale quoted amount must not be
    // treated as a quoted settlement: the stale quote is pruned instead.
    env.ledger().set_sequence_number(quote.expires_ledger + 1);
    pool.client.repay(&borrower, &loan_id, &quoted);

    assert!(pool.client.get_payoff_quote(&loan_id).is_none());
    // Interest accrued since the quote was taken, so the stale amount does not
    // fully close the loan.
    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}
