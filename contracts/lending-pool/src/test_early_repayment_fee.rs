// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the declining early-repayment fee schedule.
//!
//! The fee is the rate of the loan's current age band times its remaining
//! principal. The schedule is latched onto each loan when it is originated, a
//! payment within the regular installment owes nothing, and the payoff quote
//! carries exactly the fee that is later charged.

#![cfg(test)]

use super::*;
use crate::test_support::SupportEscrow;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env,
};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 10_000 * UNIT;
const YEAR: u32 = LEDGERS_PER_YEAR;

/// Year one 3%, year two 2%, year three onward 1%.
const SCHEDULE: (u32, u32, u32) = (300, 200, 100);

struct Fixture<'a> {
    token: Address,
    treasury: Address,
    client: LendingPoolContractClient<'a>,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths_allowing_non_root_auth();
    // Loans are held for years of ledgers, so storage must outlive that.
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 40_000_001;
        li.min_persistent_entry_ttl = 40_000_000;
    });
    env.ledger().set_sequence_number(1_000);

    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let escrow = env.register(SupportEscrow, ());
    let client = LendingPoolContractClient::new(env, &env.register(LendingPoolContract, ()));
    client.initialize(
        &admin, &token, &escrow, &800u32, &400u32, &treasury, &0u32, &0u32,
    );

    let investor = Address::generate(env);
    StellarAssetClient::new(env, &token).mint(&investor, &(PRINCIPAL * 20));
    client.deposit(&investor, &(PRINCIPAL * 20), &Tranche::Senior);

    Fixture {
        token,
        treasury,
        client,
    }
}

/// Originates and disburses a `PRINCIPAL` loan for a fresh, funded borrower.
fn originate(env: &Env, f: &Fixture<'_>, seed: u8) -> (Address, BytesN<32>) {
    let borrower = Address::generate(env);
    StellarAssetClient::new(env, &f.token).mint(&borrower, &(PRINCIPAL * 5));
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    f.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    f.client.approve_loan(&loan_id);
    f.client.add_contractor(&borrower);
    f.client.disburse(&loan_id, &borrower, &PRINCIPAL);
    (borrower, loan_id)
}

/// Moves the ledger to `age` ledgers after the loan was created.
fn at_age(env: &Env, f: &Fixture<'_>, loan_id: &BytesN<32>, age: u32) {
    let created = f.client.get_loan_info(loan_id).created_ledger;
    env.ledger().set_sequence_number(created + age);
}

/// The fee a payoff quote taken now carries.
fn quoted_fee(f: &Fixture<'_>, loan_id: &BytesN<32>) -> i128 {
    f.client.quote_payoff(loan_id);
    f.client.get_payoff_quote_fee(loan_id)
}

fn fee_at(bps: u32) -> i128 {
    PRINCIPAL * bps as i128 / BPS_SCALE as i128
}

#[test]
fn test_schedule_defaults_to_the_flat_rate_and_is_admin_configurable() {
    let env = Env::default();
    let f = setup(&env);

    let flat = f.client.get_early_repayment_fee_schedule();
    assert_eq!(flat.year1_bps, PREPAYMENT_PENALTY_BPS);
    assert_eq!(flat.year2_bps, PREPAYMENT_PENALTY_BPS);
    assert_eq!(flat.year3_plus_bps, PREPAYMENT_PENALTY_BPS);

    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let set = f.client.get_early_repayment_fee_schedule();
    assert_eq!(
        (set.year1_bps, set.year2_bps, set.year3_plus_bps),
        SCHEDULE
    );
}

#[test]
fn test_schedule_must_decline_and_stay_within_100_percent() {
    let env = Env::default();
    let f = setup(&env);

    // A rate that rises with age is not a declining schedule.
    assert_eq!(
        f.client
            .try_set_early_repayment_fee_schedule(&100, &200, &100)
            .err()
            .unwrap()
            .unwrap(),
        PoolError::InvalidAmount
    );
    assert_eq!(
        f.client
            .try_set_early_repayment_fee_schedule(&300, &200, &250)
            .err()
            .unwrap()
            .unwrap(),
        PoolError::InvalidAmount
    );
    // Above 100% is never valid.
    assert_eq!(
        f.client
            .try_set_early_repayment_fee_schedule(&10_001, &0, &0)
            .err()
            .unwrap()
            .unwrap(),
        PoolError::InvalidAmount
    );
    // Equal bands and a zero fee are fine.
    f.client.set_early_repayment_fee_schedule(&0, &0, &0);
    f.client.set_early_repayment_fee_schedule(&10_000, &10_000, &10_000);
}

#[test]
fn test_fee_in_the_first_year_band() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (_borrower, loan_id) = originate(&env, &f, 1);

    at_age(&env, &f, &loan_id, YEAR / 2);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.0));
}

#[test]
fn test_fee_in_the_second_year_band() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (_borrower, loan_id) = originate(&env, &f, 1);

    at_age(&env, &f, &loan_id, YEAR + YEAR / 2);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.1));
}

#[test]
fn test_fee_in_the_third_year_onward_band() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (_borrower, loan_id) = originate(&env, &f, 1);

    at_age(&env, &f, &loan_id, 2 * YEAR + YEAR / 2);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.2));

    // Later years keep the last band's rate.
    at_age(&env, &f, &loan_id, 5 * YEAR);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.2));
}

#[test]
fn test_fee_changes_exactly_on_the_band_boundaries() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (_borrower, loan_id) = originate(&env, &f, 1);

    // One ledger before a year is still year one; the year mark is year two.
    at_age(&env, &f, &loan_id, YEAR - 1);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.0));
    at_age(&env, &f, &loan_id, YEAR);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.1));

    // Likewise at two years.
    at_age(&env, &f, &loan_id, 2 * YEAR - 1);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.1));
    at_age(&env, &f, &loan_id, 2 * YEAR);
    assert_eq!(quoted_fee(&f, &loan_id), fee_at(SCHEDULE.2));
}

#[test]
fn test_quote_includes_the_fee_and_the_amount_charged_matches() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (borrower, loan_id) = originate(&env, &f, 1);
    let token = TokenClient::new(&env, &f.token);

    at_age(&env, &f, &loan_id, YEAR + 10);
    let quoted = f.client.quote_payoff(&loan_id);
    let fee = f.client.get_payoff_quote_fee(&loan_id);
    let debt = f.client.get_loan_info(&loan_id).outstanding_debt;
    assert_eq!(fee, fee_at(SCHEDULE.1));
    assert_eq!(quoted, debt + fee, "the quote is the debt plus the fee");

    let before = token.balance(&borrower);
    f.client.payoff_with_quote(&borrower, &loan_id, &quoted);

    // The borrower is charged exactly the quote; the fee reaches the treasury
    // and only the debt becomes pool liquidity.
    assert_eq!(token.balance(&borrower), before - quoted);
    assert_eq!(token.balance(&f.treasury), fee);
    assert_eq!(f.client.get_total_prepayment_penalties(), fee);
    let loan = f.client.get_loan_info(&loan_id);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(loan.repaid, debt);
    assert_eq!(
        f.client
            .get_loan_closing_statement(&loan_id)
            .unwrap()
            .total_penalties,
        fee
    );
    assert_eq!(f.client.get_payoff_quote_fee(&loan_id), 0);
}

#[test]
fn test_repay_at_the_quoted_amount_charges_the_quoted_fee() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (borrower, loan_id) = originate(&env, &f, 1);
    let token = TokenClient::new(&env, &f.token);

    let quoted = f.client.quote_payoff(&loan_id);
    let fee = f.client.get_payoff_quote_fee(&loan_id);
    assert_eq!(fee, fee_at(SCHEDULE.0));

    let before = token.balance(&borrower);
    f.client.repay(&borrower, &loan_id, &quoted);
    assert_eq!(token.balance(&borrower), before - quoted);
    assert_eq!(token.balance(&f.treasury), fee);
    assert_eq!(
        f.client.get_loan_info(&loan_id).status,
        LoanStatus::Repaid
    );
}

#[test]
fn test_unquoted_payoff_charges_the_fee_for_the_current_band() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (borrower, loan_id) = originate(&env, &f, 1);
    let token = TokenClient::new(&env, &f.token);

    // Same ledger as disbursement: no interest has accrued yet.
    let owed = f.client.get_loan_info(&loan_id).outstanding_debt;
    let before = token.balance(&borrower);
    f.client.repay(&borrower, &loan_id, &owed);

    let fee = fee_at(SCHEDULE.0);
    assert_eq!(token.balance(&borrower), before - owed - fee);
    assert_eq!(token.balance(&f.treasury), fee);
}

#[test]
fn test_regular_payment_owes_no_fee() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (borrower, loan_id) = originate(&env, &f, 1);
    let token = TokenClient::new(&env, &f.token);

    let monthly = f
        .client
        .get_repayment_schedule(&loan_id)
        .unwrap()
        .monthly_amount;
    let before = token.balance(&borrower);
    f.client.repay(&borrower, &loan_id, &monthly);

    assert_eq!(token.balance(&borrower), before - monthly);
    assert_eq!(token.balance(&f.treasury), 0);
    assert_eq!(f.client.get_total_prepayment_penalties(), 0);
    assert_eq!(
        f.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}

#[test]
fn test_payoff_within_the_regular_installment_owes_no_fee() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (borrower, loan_id) = originate(&env, &f, 1);
    let token = TokenClient::new(&env, &f.token);

    // Pay the balance down until what is left is less than one installment.
    let leftover = 5 * UNIT;
    f.client
        .pay_principal(&borrower, &loan_id, &(PRINCIPAL - leftover));
    let monthly = f
        .client
        .get_repayment_schedule(&loan_id)
        .unwrap()
        .monthly_amount;
    assert!(leftover <= monthly);

    // Clearing it is an early close, but it is within the regular amount.
    let before = token.balance(&borrower);
    f.client.repay(&borrower, &loan_id, &leftover);
    assert_eq!(token.balance(&borrower), before - leftover);
    assert_eq!(token.balance(&f.treasury), 0);
    assert_eq!(
        f.client.get_loan_info(&loan_id).status,
        LoanStatus::Repaid
    );

    // A quote for such a payoff carries no fee either.
    let (_b2, loan_2) = originate(&env, &f, 2);
    f.client.pay_principal(&_b2, &loan_2, &(PRINCIPAL - leftover));
    assert_eq!(quoted_fee(&f, &loan_2), 0);
}

#[test]
fn test_schedule_change_does_not_alter_loans_already_originated() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    let (_old_borrower, old_loan) = originate(&env, &f, 1);

    // The admin cuts every rate after the first loan was issued.
    f.client.set_early_repayment_fee_schedule(&50, &40, &30);
    let (_new_borrower, new_loan) = originate(&env, &f, 2);

    // The existing loan keeps the schedule it was issued under...
    let kept = f.client.get_loan_early_repayment_fee_schedule(&old_loan);
    assert_eq!(
        (kept.year1_bps, kept.year2_bps, kept.year3_plus_bps),
        SCHEDULE
    );
    assert_eq!(quoted_fee(&f, &old_loan), fee_at(SCHEDULE.0));

    // ...while the new loan is issued under the new one.
    let fresh = f.client.get_loan_early_repayment_fee_schedule(&new_loan);
    assert_eq!((fresh.year1_bps, fresh.year2_bps, fresh.year3_plus_bps), (50, 40, 30));
    assert_eq!(quoted_fee(&f, &new_loan), fee_at(50));

    // The old loan's later bands are unchanged too.
    at_age(&env, &f, &old_loan, 2 * YEAR);
    assert_eq!(quoted_fee(&f, &old_loan), fee_at(SCHEDULE.2));
}

#[test]
fn test_waived_borrower_pays_no_fee_in_the_quote() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_early_repayment_fee_schedule(&SCHEDULE.0, &SCHEDULE.1, &SCHEDULE.2);
    f.client.set_prepay_waiver_ledgers(&1u32);

    let borrower = Address::generate(&env);
    StellarAssetClient::new(&env, &f.token).mint(&borrower, &(PRINCIPAL * 5));
    f.client.record_escrow_rel_start(&borrower, &1u32);
    let loan_id = BytesN::from_array(&env, &[9u8; 32]);
    f.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    f.client.approve_loan(&loan_id);
    f.client.add_contractor(&borrower);
    f.client.disburse(&loan_id, &borrower, &PRINCIPAL);

    assert!(f.client.is_prepayment_waived(&loan_id));
    assert_eq!(quoted_fee(&f, &loan_id), 0);
}
