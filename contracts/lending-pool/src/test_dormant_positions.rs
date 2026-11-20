// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for dormant-position detection and informational flagging.
//!
//! Dormancy is measured from an investor's most recent deposit, withdrawal or
//! claim and is reported by the read-only `is_investor_dormant`. Flagging is
//! informational only — it must never block any operation.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{Address, Env};

const UNIT: i128 = 1_0000000;

/// Configure dormant reporting and return a pool plus a funded investor.
fn setup_with_period<'a>(env: &'a Env, period: u32) -> (Pool<'a>, Address) {
    let pool = setup(env);
    pool.client.set_dormant_period_ledgers(&period);
    let investor = funded(env, &pool, 2_000 * UNIT);
    (pool, investor)
}

// ── Admin-configurable period ───────────────────────────────────────────

#[test]
fn test_dormant_reporting_is_disabled_by_default() {
    let env = Env::default();
    let pool = setup(&env);
    assert_eq!(pool.client.get_dormant_period_ledgers(), 0u32);

    let investor = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);

    // Advance far past any plausible window: with reporting disabled the
    // position must never be flagged.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10_000_000);
    assert!(!pool.client.is_investor_dormant(&investor));
}

#[test]
fn test_dormant_period_is_admin_configurable_and_reads_back() {
    let env = Env::default();
    let pool = setup(&env);

    assert_eq!(pool.client.get_dormant_period_ledgers(), 0u32);
    pool.client.set_dormant_period_ledgers(&500u32);
    assert_eq!(pool.client.get_dormant_period_ledgers(), 500u32);
    pool.client.set_dormant_period_ledgers(&0u32);
    assert_eq!(pool.client.get_dormant_period_ledgers(), 0u32);
}

// ── Threshold boundaries ────────────────────────────────────────────────

#[test]
fn test_position_just_under_threshold_is_not_dormant() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);
    let last = pool.client.get_investor_last_activity(&investor);
    assert_eq!(last, 0u32, "activity clock starts at the deposit ledger");

    // One ledger short of the threshold: still active.
    env.ledger().set_sequence_number(last + 99);
    assert!(!pool.client.is_investor_dormant(&investor));
}

#[test]
fn test_position_at_exact_threshold_is_dormant() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);

    // Inactive for exactly the configured period counts as dormant.
    env.ledger().set_sequence_number(100);
    assert!(pool.client.is_investor_dormant(&investor));
}

#[test]
fn test_position_past_threshold_is_dormant() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);

    env.ledger().set_sequence_number(101);
    assert!(pool.client.is_investor_dormant(&investor));
}

#[test]
fn test_investor_with_no_activity_is_not_dormant() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    // Funded but has never deposited/withdrawn/claimed: nothing to measure.
    env.ledger().set_sequence_number(1_000);
    assert_eq!(pool.client.get_investor_last_activity(&investor), 0u32);
    assert!(!pool.client.is_investor_dormant(&investor));
}

// ── Reactivation ────────────────────────────────────────────────────────

#[test]
fn test_position_reactivated_by_deposit_after_being_flagged() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);
    env.ledger().set_sequence_number(150);
    assert!(pool.client.is_investor_dormant(&investor));

    // A fresh deposit refreshes the activity clock.
    pool.client
        .deposit(&investor, &(500 * UNIT), &Tranche::Senior);
    assert_eq!(pool.client.get_investor_last_activity(&investor), 150u32);
    assert!(!pool.client.is_investor_dormant(&investor));
}

#[test]
fn test_position_reactivated_by_withdrawal_after_being_flagged() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);
    env.ledger().set_sequence_number(200);
    assert!(pool.client.is_investor_dormant(&investor));

    pool.client.withdraw(&investor, &(100 * UNIT));
    assert_eq!(pool.client.get_investor_last_activity(&investor), 200u32);
    assert!(!pool.client.is_investor_dormant(&investor));
}

#[test]
fn test_position_reactivated_by_claim_after_being_flagged() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);

    // Route fee revenue in so the position has yield to claim.
    let payer = funded(&env, &pool, 100 * UNIT);
    pool.client.deposit_fees(&payer, &(100 * UNIT));

    env.ledger().set_sequence_number(200);
    assert!(pool.client.is_investor_dormant(&investor));

    assert!(pool.client.claim_yield(&investor) > 0);
    assert_eq!(pool.client.get_investor_last_activity(&investor), 200u32);
    assert!(!pool.client.is_investor_dormant(&investor));
}

// ── Flagging is informational only ──────────────────────────────────────

#[test]
fn test_flagging_never_blocks_deposit_withdraw_or_claim() {
    let env = Env::default();
    let (pool, investor) = setup_with_period(&env, 100);

    // Deposit path.
    pool.client
        .deposit(&investor, &(1_000 * UNIT), &Tranche::Senior);
    env.ledger().set_sequence_number(500);
    assert!(pool.client.is_investor_dormant(&investor));
    assert!(
        pool.client
            .try_deposit(&investor, &(500 * UNIT), &Tranche::Senior)
            .is_ok(),
        "a flagged position must still be able to deposit"
    );

    // Withdrawal path.
    env.ledger().set_sequence_number(1_200);
    assert!(pool.client.is_investor_dormant(&investor));
    assert!(
        pool.client.try_withdraw(&investor, &(100 * UNIT)).is_ok(),
        "a flagged position must still be able to withdraw"
    );

    // Claim path.
    let payer = funded(&env, &pool, 100 * UNIT);
    pool.client.deposit_fees(&payer, &(100 * UNIT));
    env.ledger().set_sequence_number(2_000);
    assert!(pool.client.is_investor_dormant(&investor));
    assert!(
        pool.client.try_claim_yield(&investor).is_ok(),
        "a flagged position must still be able to claim yield"
    );
}
