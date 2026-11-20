// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the periodic and lifetime caps on adjustable-rate loans.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup, Pool};
use soroban_sdk::{testutils::Address as _, BytesN, Env};

const UNIT: i128 = 1_0000000;
/// Pool default rate `setup` initialises with, which loans start at when no
/// verification registry is configured.
const POOL_RATE: u32 = 800;

/// An approved loan whose borrower is funded, keyed by `seed`.
fn approved_loan(env: &Env, pool: &Pool<'_>, borrower: &Address, seed: u8) -> BytesN<32> {
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    pool.client
        .request_loan(borrower, &loan_id, &(10_000 * UNIT));
    pool.client.approve_loan(&loan_id);
    loan_id
}

fn funded_pool(env: &Env) -> Pool<'_> {
    let pool = setup(env);
    let investor = funded(env, &pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);
    pool
}

fn rate(pool: &Pool<'_>, loan_id: &BytesN<32>) -> u32 {
    pool.client.get_loan_info(loan_id).interest_rate_bps
}

#[test]
fn test_starting_rate_is_latched_at_origination() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    let terms = pool.client.get_loan_origin_terms(&loan_id);
    assert_eq!(terms.starting_rate_bps, POOL_RATE);
    assert_eq!(terms.original_principal, 10_000 * UNIT);
}

#[test]
fn test_adjustment_within_both_caps_is_applied() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    pool.client.set_rate_adjustment_caps(&100, &300);
    assert_eq!(pool.client.get_rate_adjustment_caps(), (100, 300));

    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 75));
    assert!(has_event(&env, "rate_adj"));
    assert_eq!(rate(&pool, &loan_id), POOL_RATE + 75);

    // Downward adjustments are bounded the same way.
    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE - 25));
    assert_eq!(rate(&pool, &loan_id), POOL_RATE - 25);
}

#[test]
fn test_adjustment_at_exactly_the_periodic_cap_is_applied() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    pool.client.set_rate_adjustment_caps(&100, &300);

    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 100));
    assert_eq!(rate(&pool, &loan_id), POOL_RATE + 100);
}

#[test]
fn test_adjustment_over_the_periodic_cap_is_rejected() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    pool.client.set_rate_adjustment_caps(&100, &300);

    let res = pool
        .client
        .try_adjust_loan_rate(&loan_id, &(POOL_RATE + 101));
    assert_eq!(
        res.unwrap_err(),
        Ok(RateAdjustmentError::PeriodicCapExceeded)
    );
    let res = pool
        .client
        .try_adjust_loan_rate(&loan_id, &(POOL_RATE - 101));
    assert_eq!(
        res.unwrap_err(),
        Ok(RateAdjustmentError::PeriodicCapExceeded)
    );
    assert_eq!(rate(&pool, &loan_id), POOL_RATE);
}

#[test]
fn test_lifetime_cap_rejects_an_otherwise_valid_periodic_adjustment() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    pool.client.set_rate_adjustment_caps(&100, &250);

    // Three steps within the periodic cap bring the rate to start + 250,
    // exactly the lifetime cap.
    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 100));
    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 200));
    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 250));

    // +50 is well within the periodic cap but would take the loan 300 above
    // its starting rate.
    let res = pool
        .client
        .try_adjust_loan_rate(&loan_id, &(POOL_RATE + 300));
    assert_eq!(
        res.unwrap_err(),
        Ok(RateAdjustmentError::LifetimeCapExceeded)
    );
    assert_eq!(rate(&pool, &loan_id), POOL_RATE + 250);

    // Moving back toward the starting rate is still allowed.
    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 150));
    assert_eq!(rate(&pool, &loan_id), POOL_RATE + 150);
}

#[test]
fn test_lifetime_cap_bounds_downward_moves_too() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    pool.client.set_rate_adjustment_caps(&0, &150);

    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE - 150));
    let res = pool
        .client
        .try_adjust_loan_rate(&loan_id, &(POOL_RATE - 151));
    assert_eq!(
        res.unwrap_err(),
        Ok(RateAdjustmentError::LifetimeCapExceeded)
    );
}

#[test]
fn test_caps_are_computed_from_each_loans_own_starting_rate() {
    let env = Env::default();
    let pool = funded_pool(&env);

    // Loan A starts at the pool rate (800 bps).
    let a = approved_loan(&env, &pool, &Address::generate(&env), 1);

    // Loan B starts at 400 bps: an excellent-tier borrower priced through
    // the verification registry.
    let registry_id = env.register(verification_registry::VerificationRegistryContract, ());
    let registry =
        verification_registry::VerificationRegistryContractClient::new(&env, &registry_id);
    registry.initialize(&pool.admin);
    pool.client.set_verification_registry(&registry_id);
    let excellent = Address::generate(&env);
    registry.register_verification(
        &excellent,
        &BytesN::from_array(&env, &[9u8; 32]),
        &1_000u32,
        &85u32,
    );
    let b = approved_loan(&env, &pool, &excellent, 2);
    assert_eq!(pool.client.get_loan_origin_terms(&b).starting_rate_bps, 400);

    pool.client.set_rate_adjustment_caps(&0, &300);

    // 1,100 is within 300 of A's start (800)...
    pool.client.adjust_loan_rate(&a, &1_100);
    // ...but not of B's start (400), whatever the pool rate or other loans.
    let res = pool.client.try_adjust_loan_rate(&b, &1_100);
    assert_eq!(
        res.unwrap_err(),
        Ok(RateAdjustmentError::LifetimeCapExceeded)
    );
    pool.client.adjust_loan_rate(&b, &700);
    let res = pool.client.try_adjust_loan_rate(&b, &701);
    assert_eq!(
        res.unwrap_err(),
        Ok(RateAdjustmentError::LifetimeCapExceeded)
    );
}

#[test]
fn test_no_caps_by_default() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let loan_id = approved_loan(&env, &pool, &Address::generate(&env), 1);
    assert_eq!(pool.client.get_rate_adjustment_caps(), (0, 0));

    pool.client.adjust_loan_rate(&loan_id, &(POOL_RATE + 2_000));
    assert_eq!(rate(&pool, &loan_id), POOL_RATE + 2_000);
}

#[test]
fn test_invalid_adjustments_rejected() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = Address::generate(&env);
    let loan_id = approved_loan(&env, &pool, &borrower, 1);

    let res = pool.client.try_adjust_loan_rate(&loan_id, &0);
    assert_eq!(res.unwrap_err(), Ok(RateAdjustmentError::InvalidRate));
    let res = pool.client.try_adjust_loan_rate(&loan_id, &POOL_RATE);
    assert_eq!(res.unwrap_err(), Ok(RateAdjustmentError::InvalidRate));

    let missing = BytesN::from_array(&env, &[42u8; 32]);
    let res = pool.client.try_adjust_loan_rate(&missing, &900);
    assert_eq!(res.unwrap_err(), Ok(RateAdjustmentError::LoanNotFound));

    let requested = BytesN::from_array(&env, &[3u8; 32]);
    pool.client
        .request_loan(&borrower, &requested, &(1_000 * UNIT));
    let res = pool.client.try_adjust_loan_rate(&requested, &900);
    assert_eq!(res.unwrap_err(), Ok(RateAdjustmentError::LoanNotActive));
}

#[test]
fn test_set_caps_validation() {
    let env = Env::default();
    let pool = setup(&env);
    let res = pool.client.try_set_rate_adjustment_caps(&10_001, &0);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    let res = pool.client.try_set_rate_adjustment_caps(&0, &10_001);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
}
