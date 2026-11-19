// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the admin-set maximum share of a tranche any one investor may
//! hold.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, Env};

const UNIT: i128 = 1_0000000;

/// A fresh investor holding `deposit` in `tranche` (plus spare tokens).
fn investor_with(env: &Env, pool: &Pool<'_>, tranche: &Tranche, deposit: i128) -> Address {
    let who = funded(env, pool, 100_000 * UNIT);
    pool.client.deposit(&who, &deposit, tranche);
    who
}

fn position(pool: &Pool<'_>, who: &Address) -> i128 {
    pool.client.get_investor_info(who).deposited
}

fn tranche_total(pool: &Pool<'_>, tranche: &Tranche) -> i128 {
    pool.client.get_tranche_info(tranche).total_deposited
}

#[test]
fn test_no_share_cap_by_default() {
    let env = Env::default();
    let pool = setup(&env);
    assert_eq!(pool.client.get_investor_tranche_share_cap(), 0);

    // One investor may hold the entire tranche.
    let whale = investor_with(&env, &pool, &Tranche::Senior, 50_000 * UNIT);
    pool.client
        .deposit(&whale, &(10_000 * UNIT), &Tranche::Senior);
    assert_eq!(position(&pool, &whale), 60_000 * UNIT);
}

#[test]
fn test_deposit_under_the_cap_is_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let _a = investor_with(&env, &pool, &Tranche::Senior, 1_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&5_000);

    // 500 / 1,500 = 33% <= 50%.
    let b = investor_with(&env, &pool, &Tranche::Senior, 500 * UNIT);
    assert_eq!(position(&pool, &b), 500 * UNIT);
}

#[test]
fn test_deposit_reaching_exactly_the_cap_is_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let _a = investor_with(&env, &pool, &Tranche::Senior, 1_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&5_000);

    // 1,000 / 2,000 = exactly 50%.
    let b = investor_with(&env, &pool, &Tranche::Senior, 1_000 * UNIT);
    assert_eq!(position(&pool, &b), 1_000 * UNIT);
}

#[test]
fn test_deposit_exceeding_the_cap_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let _a = investor_with(&env, &pool, &Tranche::Senior, 1_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&5_000);

    // 1,001 / 2,001 > 50%: rejected, and nothing about the pool changes.
    let b = funded(&env, &pool, 10_000 * UNIT);
    let res = pool
        .client
        .try_deposit(&b, &(1_001 * UNIT), &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
    assert_eq!(position(&pool, &b), 0);
    assert_eq!(tranche_total(&pool, &Tranche::Senior), 1_000 * UNIT);
    assert_eq!(pool.client.get_liquidity(), 1_000 * UNIT);
}

#[test]
fn test_top_up_that_would_exceed_the_cap_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let a = investor_with(&env, &pool, &Tranche::Senior, 1_000 * UNIT);
    let _b = investor_with(&env, &pool, &Tranche::Senior, 3_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&4_000);

    // A: (1,000 + 600) / 4,600 = 34.8% <= 40%.
    pool.client.deposit(&a, &(600 * UNIT), &Tranche::Senior);
    // A: (1,600 + 1,000) / 5,600 = 46.4% > 40%.
    let res = pool
        .client
        .try_deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
    assert_eq!(position(&pool, &a), 1_600 * UNIT);
}

#[test]
fn test_lowering_the_cap_keeps_existing_position_but_blocks_additions() {
    let env = Env::default();
    let pool = setup(&env);
    let a = investor_with(&env, &pool, &Tranche::Senior, 6_000 * UNIT);
    let _b = investor_with(&env, &pool, &Tranche::Senior, 4_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&7_000);

    // A holds 60%; the cap is now lowered below that.
    pool.client.set_investor_tranche_share_cap(&2_500);

    // A's position is not forcibly reduced...
    assert_eq!(position(&pool, &a), 6_000 * UNIT);
    assert_eq!(tranche_total(&pool, &Tranche::Senior), 10_000 * UNIT);
    assert_eq!(pool.client.debt_balance(&a, &Tranche::Senior), 6_000 * UNIT);

    // ...but A cannot add to it, not even a little.
    let res = pool.client.try_deposit(&a, &UNIT, &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
    assert_eq!(position(&pool, &a), 6_000 * UNIT);

    // Other investors can still deposit within the new cap.
    let c = investor_with(&env, &pool, &Tranche::Senior, 2_000 * UNIT);
    assert_eq!(position(&pool, &c), 2_000 * UNIT);

    // A can still reduce their position.
    pool.client.withdraw(&a, &(1_000 * UNIT));
    assert_eq!(position(&pool, &a), 5_000 * UNIT);
}

#[test]
fn test_share_is_measured_against_tranche_cap_so_empty_tranche_can_be_seeded() {
    let env = Env::default();
    let pool = setup(&env);
    // Tranche capped at 4,000 (through its timelock).
    pool.client
        .set_tranche_deposit_cap(&Tranche::Junior, &(4_000 * UNIT));
    let seq = env.ledger().sequence();
    env.ledger()
        .set_sequence_number(seq + pool.client.get_deposit_cap_delay() + 1);
    pool.client
        .set_tranche_deposit_cap(&Tranche::Junior, &(4_000 * UNIT));
    pool.client.set_investor_tranche_share_cap(&2_500);

    // The first depositor may take up to 25% of the 4,000 tranche.
    let a = funded(&env, &pool, 10_000 * UNIT);
    let res = pool
        .client
        .try_deposit(&a, &(1_001 * UNIT), &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Junior);
    assert_eq!(position(&pool, &a), 1_000 * UNIT);
}

#[test]
fn test_share_is_per_tranche() {
    let env = Env::default();
    let pool = setup(&env);
    let _senior_whale = investor_with(&env, &pool, &Tranche::Senior, 9_000 * UNIT);
    let _j1 = investor_with(&env, &pool, &Tranche::Junior, 1_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&5_000);

    // 1,000 / 2,000 of the junior tranche is fine, even though it would be
    // far below 50% of the pool as a whole either way: only the investor's
    // own tranche counts.
    let j2 = investor_with(&env, &pool, &Tranche::Junior, 1_000 * UNIT);
    assert_eq!(position(&pool, &j2), 1_000 * UNIT);
    let res = pool.client.try_deposit(&j2, &UNIT, &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
}

#[test]
fn test_set_share_cap_validation_and_disable() {
    let env = Env::default();
    let pool = setup(&env);
    let res = pool.client.try_set_investor_tranche_share_cap(&10_001);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));

    let a = investor_with(&env, &pool, &Tranche::Senior, 1_000 * UNIT);
    pool.client.set_investor_tranche_share_cap(&5_000);
    assert_eq!(pool.client.get_investor_tranche_share_cap(), 5_000);
    assert!(pool
        .client
        .try_deposit(&a, &UNIT, &Tranche::Senior)
        .is_err());

    pool.client.set_investor_tranche_share_cap(&0);
    pool.client.deposit(&a, &UNIT, &Tranche::Senior);
}
