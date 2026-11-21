// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

/// Compute the exact remaining balance (including accrued interest) by using
/// `get_accrued_interest` + `outstanding_debt` or calling `get_loan_info`.
fn current_payoff_amount(
    env: &Env,
    client: &LendingPoolContractClient<'_>,
    loan_id: &BytesN<32>,
) -> i128 {
    // Enable a 10-ledger payoff quote window temporarily or use get_accrued_debt
    // directly by inspecting loan via `as_contract` + `accrue_interest`.
    let mut loan = client.get_loan_info(loan_id);
    env.as_contract(&client.address, || {
        LendingPoolContract::accrue_interest(env, &mut loan);
    });
    loan.outstanding_debt
}

#[test]
fn closing_statement_reconciles_normal_payoff_with_fees() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    // Configure 200 bps (2%) origination fee.
    client.set_origination_fee_bps(&200);

    let investor = funded(&env, &pool, 200_000);
    client.deposit(&investor, &200_000, &Tranche::Senior);

    let borrower = funded(&env, &pool, 500_000);
    let contractor = Address::generate(&env);
    client.add_contractor(&contractor);
    let loan_id = BytesN::from_array(&env, &[31u8; 32]);
    client.request_loan(&borrower, &loan_id, &50_000);
    client.approve_loan(&loan_id);
    client.disburse(&loan_id, &contractor, &50_000);

    // Origination fee = 50_000 * 200 / 10_000 = 1_000.
    // Pay 12 installments (30 test days = 30 * LEDGERS_PER_DAY apart) so final payment clears at maturity.
    for paid_installments in 0..DEFAULT_DURATION_MONTHS {
        env.ledger().with_mut(|li| {
            li.sequence_number += 30 * LEDGERS_PER_DAY;
        });
        let remaining = current_payoff_amount(&env, client, &loan_id);
        let payment = if paid_installments + 1 >= DEFAULT_DURATION_MONTHS {
            remaining
        } else {
            (remaining / (DEFAULT_DURATION_MONTHS - paid_installments) as i128).max(1)
        };
        client.repay(&borrower, &loan_id, &payment);
    }

    assert!(has_event(&env, "loan_closed"));
    let stmt = client
        .get_loan_closing_statement(&loan_id)
        .expect("closing statement must be persisted");
    let loan = client.get_loan_info(&loan_id);
    assert_eq!(stmt.total_principal, loan.principal);
    assert_eq!(stmt.total_interest, loan.repaid - loan.principal);
    assert!(stmt.total_interest > 0);
    assert_eq!(stmt.total_fees, 1_000);
    assert_eq!(stmt.total_penalties, 0);
    assert_eq!(stmt.total_rebates, 0);
    assert_eq!(stmt.closing_ledger, env.ledger().sequence());
}

#[test]
fn closing_statement_records_early_payoff_prepayment_penalty() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    let investor = funded(&env, &pool, 200_000);
    client.deposit(&investor, &200_000, &Tranche::Senior);

    let borrower = funded(&env, &pool, 100_000);
    let contractor = Address::generate(&env);
    client.add_contractor(&contractor);
    let loan_id = BytesN::from_array(&env, &[32u8; 32]);
    client.request_loan(&borrower, &loan_id, &50_000);
    client.approve_loan(&loan_id);
    client.disburse(&loan_id, &contractor, &50_000);

    // Pay off immediately in 1 shot (ahead of 12-month schedule) -> triggers 1% prepayment penalty.
    let remaining = current_payoff_amount(&env, client, &loan_id);
    let expected_penalty = (remaining * PREPAYMENT_PENALTY_BPS as i128) / BPS_SCALE as i128;
    client.repay(&borrower, &loan_id, &remaining);

    assert!(has_event(&env, "loan_closed"));
    let stmt = client
        .get_loan_closing_statement(&loan_id)
        .expect("closing statement must exist");
    assert_eq!(stmt.total_principal, 50_000);
    assert_eq!(stmt.total_penalties, expected_penalty);
    assert!(stmt.total_penalties > 0);
    assert_eq!(stmt.closing_ledger, env.ledger().sequence());
}

#[test]
fn closing_statement_records_maturity_rebate_after_claim() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    let investor = funded(&env, &pool, 200_000);
    client.deposit(&investor, &200_000, &Tranche::Senior);

    let borrower = funded(&env, &pool, 150_000);
    let contractor = Address::generate(&env);
    client.add_contractor(&contractor);
    let loan_id = BytesN::from_array(&env, &[33u8; 32]);
    client.request_loan(&borrower, &loan_id, &50_000);
    client.approve_loan(&loan_id);
    client.disburse(&loan_id, &contractor, &50_000);

    // Advance 30 test days (zero missed payments) so interest accrues, then pay off.
    env.ledger().with_mut(|li| {
        li.sequence_number += 30 * LEDGERS_PER_DAY;
    });
    let remaining = current_payoff_amount(&env, client, &loan_id);
    client.repay(&borrower, &loan_id, &remaining);

    let rebate = client.claim_maturity_rebate(&loan_id);
    assert!(rebate > 0);

    let stmt = client
        .get_loan_closing_statement(&loan_id)
        .expect("closing statement must exist");
    assert_eq!(stmt.total_rebates, rebate);
    assert_eq!(stmt.total_principal, 50_000);
    assert!(stmt.total_interest > 0);
}
