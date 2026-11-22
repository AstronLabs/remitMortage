// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the maximum loan-to-value limit enforced at origination, with
//! collateral valued by a real `oracle-price` contract.
//!
//! The fixture loan borrows 7,000 against 10,000 units of collateral priced
//! at 1.0, so its LTV is exactly 7,000 bps.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use oracle_price::{AggregationConfig, OraclePriceContract, OraclePriceContractClient};
use soroban_sdk::{testutils::{Address as _, Ledger as _}, Address, BytesN, Env, Symbol};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 7_000 * UNIT;
const COLLATERAL: i128 = 10_000 * UNIT;
const FIXTURE_LTV_BPS: u32 = 7_000;
/// 1.0 in the oracle's 7-decimal fixed point.
const PRICE: i128 = ORACLE_PRICE_SCALE;
const MAX_STALENESS: u32 = 100;

struct Fixture<'a> {
    pool: Pool<'a>,
    oracle: OraclePriceContractClient<'a>,
    reporter: Address,
}

/// A pool with deposits, wired to a live oracle that has just been priced.
fn fixture(env: &Env) -> Fixture<'_> {
    let pool = setup(env);
    let investor = funded(env, &pool, PRINCIPAL * 10);
    pool.client
        .deposit(&investor, &(PRINCIPAL * 10), &Tranche::Senior);

    let oracle = OraclePriceContractClient::new(env, &env.register(OraclePriceContract, ()));
    oracle.initialize(&Address::generate(env));
    oracle.set_aggregation_config(&AggregationConfig {
        min_quorum: 1,
        max_staleness_ledgers: MAX_STALENESS,
        max_deviation_bps: 10_000,
    });
    let reporter = Address::generate(env);
    oracle.add_reporter(&reporter);
    oracle.submit_price(&reporter, &PRICE);

    pool.client.set_price_oracle(&oracle.address);
    Fixture {
        pool,
        oracle,
        reporter,
    }
}

/// Requests a `PRINCIPAL` loan backed by `COLLATERAL` units.
fn request(env: &Env, f: &Fixture<'_>, seed: u8) -> BytesN<32> {
    let borrower = funded(env, &f.pool, PRINCIPAL);
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    f.pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    f.pool.client.set_loan_collateral(
        &loan_id,
        &COLLATERAL,
        &3_000u32,
        &Symbol::new(env, "property"),
    );
    loan_id
}

#[test]
fn test_limit_is_off_by_default_and_needs_no_oracle() {
    let env = Env::default();
    let pool = setup(&env);
    let investor = funded(&env, &pool, PRINCIPAL * 10);
    pool.client
        .deposit(&investor, &(PRINCIPAL * 10), &Tranche::Senior);
    assert_eq!(pool.client.get_max_ltv_bps(), 0);
    assert!(pool.client.get_price_oracle().is_none());

    let borrower = funded(&env, &pool, PRINCIPAL);
    let loan_id = BytesN::from_array(&env, &[1u8; 32]);
    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    pool.client.approve_loan(&loan_id);
    assert_eq!(
        pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}

#[test]
fn test_loan_under_the_limit_is_approved() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_ltv_bps(&8_000u32);

    let loan_id = request(&env, &f, 1);
    f.pool.client.approve_loan(&loan_id);
    assert_eq!(
        f.pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}

#[test]
fn test_loan_exactly_at_the_limit_is_approved() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_ltv_bps(&FIXTURE_LTV_BPS);

    let loan_id = request(&env, &f, 1);
    f.pool.client.approve_loan(&loan_id);
    assert_eq!(
        f.pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );
}

#[test]
fn test_loan_over_the_limit_is_rejected() {
    let env = Env::default();
    let f = fixture(&env);
    // One basis point below the loan's 7,000 bps.
    f.pool.client.set_max_ltv_bps(&(FIXTURE_LTV_BPS - 1));

    let loan_id = request(&env, &f, 1);
    let err = f.pool.client.try_approve_loan(&loan_id);
    assert_eq!(
        err.err().unwrap().unwrap(),
        PoolError::CollateralRatioBreached
    );
    // Nothing was originated.
    assert_eq!(
        f.pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Requested
    );
}

#[test]
fn test_price_drop_pushes_a_loan_over_the_limit() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_ltv_bps(&FIXTURE_LTV_BPS);
    // Collateral now worth 90% as much: 7,000 / 9,000 is above 70%.
    f.oracle.submit_price(&f.reporter, &(PRICE * 9 / 10));

    let loan_id = request(&env, &f, 1);
    let err = f.pool.client.try_approve_loan(&loan_id);
    assert_eq!(
        err.err().unwrap().unwrap(),
        PoolError::CollateralRatioBreached
    );
}

#[test]
fn test_stale_oracle_price_is_rejected() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_ltv_bps(&8_000u32);
    let loan_id = request(&env, &f, 1);

    // The last report is now older than the oracle's staleness window.
    let now = env.ledger().sequence();
    env.ledger().set_sequence_number(now + MAX_STALENESS + 1);
    let err = f.pool.client.try_approve_loan(&loan_id);
    assert_eq!(
        err.err().unwrap().unwrap(),
        PoolError::InvalidCollateralRatio
    );

    // A fresh report makes the same loan approvable again.
    f.oracle.submit_price(&f.reporter, &PRICE);
    f.pool.client.approve_loan(&loan_id);
}

#[test]
fn test_missing_oracle_price_is_rejected() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_ltv_bps(&8_000u32);

    // An oracle that never received a report has no price to give.
    let empty = OraclePriceContractClient::new(&env, &env.register(OraclePriceContract, ()));
    empty.initialize(&Address::generate(&env));
    empty.set_aggregation_config(&AggregationConfig {
        min_quorum: 1,
        max_staleness_ledgers: MAX_STALENESS,
        max_deviation_bps: 10_000,
    });
    f.pool.client.set_price_oracle(&empty.address);

    let loan_id = request(&env, &f, 1);
    let err = f.pool.client.try_approve_loan(&loan_id);
    assert_eq!(
        err.err().unwrap().unwrap(),
        PoolError::InvalidCollateralRatio
    );
}

#[test]
fn test_limit_without_an_oracle_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let investor = funded(&env, &pool, PRINCIPAL * 10);
    pool.client
        .deposit(&investor, &(PRINCIPAL * 10), &Tranche::Senior);
    pool.client.set_max_ltv_bps(&8_000u32);

    let borrower = funded(&env, &pool, PRINCIPAL);
    let loan_id = BytesN::from_array(&env, &[1u8; 32]);
    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    let err = pool.client.try_approve_loan(&loan_id);
    assert_eq!(
        err.err().unwrap().unwrap(),
        PoolError::InvalidCollateralRatio
    );
}

#[test]
fn test_admin_changing_the_limit_changes_what_is_approved() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_ltv_bps(&6_000u32);
    assert_eq!(f.pool.client.get_max_ltv_bps(), 6_000);

    let loan_id = request(&env, &f, 1);
    assert_eq!(
        f.pool
            .client
            .try_approve_loan(&loan_id)
            .err()
            .unwrap()
            .unwrap(),
        PoolError::CollateralRatioBreached
    );

    // Raising the limit lets the same loan through.
    f.pool.client.set_max_ltv_bps(&FIXTURE_LTV_BPS);
    f.pool.client.approve_loan(&loan_id);

    // Lowering it afterwards blocks the next one, but not the loan already
    // originated.
    f.pool.client.set_max_ltv_bps(&6_000u32);
    let second = request(&env, &f, 2);
    assert_eq!(
        f.pool
            .client
            .try_approve_loan(&second)
            .err()
            .unwrap()
            .unwrap(),
        PoolError::CollateralRatioBreached
    );
    assert_eq!(
        f.pool.client.get_loan_info(&loan_id).status,
        LoanStatus::Approved
    );

    // Zero turns the limit back off.
    f.pool.client.set_max_ltv_bps(&0u32);
    f.pool.client.approve_loan(&second);
}

#[test]
fn test_limit_above_100_percent_is_invalid() {
    let env = Env::default();
    let f = fixture(&env);
    assert_eq!(
        f.pool
            .client
            .try_set_max_ltv_bps(&10_001u32)
            .err()
            .unwrap()
            .unwrap(),
        PoolError::InvalidAmount
    );
    f.pool.client.set_max_ltv_bps(&10_000u32);
}
