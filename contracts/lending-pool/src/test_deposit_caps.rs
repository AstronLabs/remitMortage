// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for admin-set per-tranche and per-investor deposit caps.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup, Pool};
use soroban_sdk::{testutils::Ledger as _, Env};

const UNIT: i128 = 1_0000000;

/// Moves the ledger forward by `ledgers`.
fn advance(env: &Env, ledgers: u32) {
    let seq = env.ledger().sequence();
    env.ledger().set_sequence_number(seq + ledgers);
}

/// Runs a tranche-cap change through the whole timelock: propose, wait out the
/// delay, execute.
fn apply_tranche_cap(env: &Env, pool: &Pool<'_>, tranche: &Tranche, cap: i128) {
    pool.client.set_tranche_deposit_cap(tranche, &cap);
    advance(env, pool.client.get_deposit_cap_delay() + 1);
    pool.client.set_tranche_deposit_cap(tranche, &cap);
    assert_eq!(pool.client.get_tranche_deposit_cap(tranche), cap);
}

fn apply_investor_cap(env: &Env, pool: &Pool<'_>, cap: i128) {
    pool.client.set_investor_deposit_cap(&cap);
    advance(env, pool.client.get_deposit_cap_delay() + 1);
    pool.client.set_investor_deposit_cap(&cap);
    assert_eq!(pool.client.get_investor_deposit_cap(), cap);
}

// ── Defaults ────────────────────────────────────────────────────────────

#[test]
fn test_no_caps_by_default() {
    let env = Env::default();
    let pool = setup(&env);
    assert_eq!(pool.client.get_tranche_deposit_cap(&Tranche::Senior), 0);
    assert_eq!(pool.client.get_tranche_deposit_cap(&Tranche::Junior), 0);
    assert_eq!(pool.client.get_investor_deposit_cap(), 0);

    let whale = funded(&env, &pool, 1_000_000 * UNIT);
    pool.client
        .deposit(&whale, &(1_000_000 * UNIT), &Tranche::Junior);
}

// ── Tranche cap ─────────────────────────────────────────────────────────

#[test]
fn test_tranche_cap_exact_boundary() {
    let env = Env::default();
    let pool = setup(&env);
    apply_tranche_cap(&env, &pool, &Tranche::Junior, 1_000 * UNIT);

    let a = funded(&env, &pool, 2_000 * UNIT);
    let b = funded(&env, &pool, 2_000 * UNIT);

    // Landing exactly on the cap succeeds.
    pool.client.deposit(&a, &(600 * UNIT), &Tranche::Junior);
    pool.client.deposit(&b, &(400 * UNIT), &Tranche::Junior);
    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Junior)
            .total_deposited,
        1_000 * UNIT
    );

    // One stroop over reverts with the tranche-specific error.
    let res = pool.client.try_deposit(&a, &1, &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));
}

#[test]
fn test_tranche_cap_one_over_rejected_and_state_untouched() {
    let env = Env::default();
    let pool = setup(&env);
    apply_tranche_cap(&env, &pool, &Tranche::Senior, 1_000 * UNIT);

    let a = funded(&env, &pool, 2_000 * UNIT);
    let res = pool
        .client
        .try_deposit(&a, &(1_000 * UNIT + 1), &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));

    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Senior)
            .total_deposited,
        0
    );
    assert_eq!(pool.client.get_liquidity(), 0);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 0);
}

#[test]
fn test_tranche_caps_are_independent() {
    let env = Env::default();
    let pool = setup(&env);
    // Cap only the junior tranche (the oversubscription case in the issue).
    apply_tranche_cap(&env, &pool, &Tranche::Junior, 500 * UNIT);

    let j = funded(&env, &pool, 5_000 * UNIT);
    let s = funded(&env, &pool, 5_000 * UNIT);
    let res = pool.client.try_deposit(&j, &(501 * UNIT), &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));

    // Senior is unaffected by the junior cap.
    pool.client.deposit(&s, &(5_000 * UNIT), &Tranche::Senior);
}

// ── Investor cap ────────────────────────────────────────────────────────

#[test]
fn test_investor_cap_exact_boundary() {
    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 1_000 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_000 * UNIT);

    let res = pool.client.try_deposit(&a, &1, &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
}

#[test]
fn test_investor_cap_is_per_investor_not_pooled() {
    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 1_000 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    let b = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    // A being at the cap does not stop B.
    pool.client.deposit(&b, &(1_000 * UNIT), &Tranche::Senior);
}

// ── Top-ups ─────────────────────────────────────────────────────────────

#[test]
fn test_top_up_counts_existing_position_against_investor_cap() {
    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 1_000 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(600 * UNIT), &Tranche::Senior);

    // 600 + 401 would be 1001: rejected even though 401 alone is under the cap.
    let res = pool.client.try_deposit(&a, &(401 * UNIT), &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));

    // Topping up to exactly the cap works, then nothing more fits.
    pool.client.deposit(&a, &(400 * UNIT), &Tranche::Senior);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_000 * UNIT);
    let res = pool.client.try_deposit(&a, &1, &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
}

#[test]
fn test_top_up_counts_against_tranche_cap() {
    let env = Env::default();
    let pool = setup(&env);
    apply_tranche_cap(&env, &pool, &Tranche::Junior, 1_000 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(700 * UNIT), &Tranche::Junior);
    let res = pool.client.try_deposit(&a, &(301 * UNIT), &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));
    pool.client.deposit(&a, &(300 * UNIT), &Tranche::Junior);
}

#[test]
fn test_lockup_deposits_respect_caps() {
    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 1_000 * UNIT);
    apply_tranche_cap(&env, &pool, &Tranche::Senior, 1_500 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    let b = funded(&env, &pool, 5_000 * UNIT);
    pool.client
        .deposit_with_lockup(&a, &(1_000 * UNIT), &Tranche::Senior, &LockupTier::None);

    let res = pool
        .client
        .try_deposit_with_lockup(&a, &1, &Tranche::Senior, &LockupTier::None);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));

    // B is within its own cap but the tranche only has 500 left.
    let res =
        pool.client
            .try_deposit_with_lockup(&b, &(501 * UNIT), &Tranche::Senior, &LockupTier::None);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));
    pool.client
        .deposit_with_lockup(&b, &(500 * UNIT), &Tranche::Senior, &LockupTier::None);
}

// ── Error distinction ───────────────────────────────────────────────────

#[test]
fn test_tranche_and_investor_cap_errors_are_distinct() {
    assert_ne!(
        PoolError::TrancheCapExceeded as u32,
        PoolError::InvestorCapExceeded as u32
    );

    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 100 * UNIT);
    apply_tranche_cap(&env, &pool, &Tranche::Junior, 1_000 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    let b = funded(&env, &pool, 5_000 * UNIT);

    // Over the investor cap only.
    let res = pool.client.try_deposit(&a, &(101 * UNIT), &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));

    // Over the tranche cap only: fill the tranche with ten investors at 100.
    for _ in 0..10 {
        let i = funded(&env, &pool, 100 * UNIT);
        pool.client.deposit(&i, &(100 * UNIT), &Tranche::Junior);
    }
    let res = pool.client.try_deposit(&b, &(1 * UNIT), &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));

    // Over both: the per-investor cap is the one reported.
    let res = pool.client.try_deposit(&b, &(500 * UNIT), &Tranche::Junior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
}

// ── Cap increases (and the timelock) ────────────────────────────────────

#[test]
fn test_cap_increase_unlocks_deposits_only_after_timelock() {
    let env = Env::default();
    let pool = setup(&env);
    apply_tranche_cap(&env, &pool, &Tranche::Senior, 1_000 * UNIT);

    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    let res = pool.client.try_deposit(&a, &(500 * UNIT), &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));

    // Proposing the increase does not change the live cap.
    pool.client
        .set_tranche_deposit_cap(&Tranche::Senior, &(2_000 * UNIT));
    assert_eq!(
        pool.client.get_tranche_deposit_cap(&Tranche::Senior),
        1_000 * UNIT
    );
    let res = pool.client.try_deposit(&a, &(500 * UNIT), &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::TrancheCapExceeded));

    // After the delay it executes and the deposit goes through.
    advance(&env, pool.client.get_deposit_cap_delay());
    pool.client
        .set_tranche_deposit_cap(&Tranche::Senior, &(2_000 * UNIT));
    pool.client.deposit(&a, &(500 * UNIT), &Tranche::Senior);
    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Senior)
            .total_deposited,
        1_500 * UNIT
    );
}

#[test]
fn test_investor_cap_increase_after_timelock() {
    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 1_000 * UNIT);
    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);

    apply_investor_cap(&env, &pool, 1_200 * UNIT);
    pool.client.deposit(&a, &(200 * UNIT), &Tranche::Senior);
    let res = pool.client.try_deposit(&a, &1, &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
}

#[test]
fn test_cap_decrease_blocks_new_deposits_but_keeps_existing_position() {
    let env = Env::default();
    let pool = setup(&env);
    apply_investor_cap(&env, &pool, 1_000 * UNIT);
    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);

    apply_investor_cap(&env, &pool, 400 * UNIT);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_000 * UNIT);
    let res = pool.client.try_deposit(&a, &1, &Tranche::Senior);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvestorCapExceeded));
}

#[test]
fn test_removing_a_cap_with_zero() {
    let env = Env::default();
    let pool = setup(&env);
    apply_tranche_cap(&env, &pool, &Tranche::Senior, 100 * UNIT);
    apply_tranche_cap(&env, &pool, &Tranche::Senior, 0);
    let a = funded(&env, &pool, 5_000 * UNIT);
    pool.client.deposit(&a, &(5_000 * UNIT), &Tranche::Senior);
}

// ── Timelock + logging ──────────────────────────────────────────────────

#[test]
fn test_cap_change_timelock_boundaries() {
    let env = Env::default();
    let pool = setup(&env);
    let delay = pool.client.get_deposit_cap_delay();
    assert!(delay > 0, "the timelock is on by default");

    let proposed_at = env.ledger().sequence();
    pool.client
        .set_tranche_deposit_cap(&Tranche::Junior, &(100 * UNIT));
    let pending = pool
        .client
        .get_pending_tranche_cap_change(&Tranche::Junior)
        .unwrap();
    assert_eq!(pending.cap, 100 * UNIT);
    assert_eq!(pending.execute_after, proposed_at + delay);

    // One ledger early is still locked.
    env.ledger().set_sequence_number(pending.execute_after - 1);
    let res = pool
        .client
        .try_set_tranche_deposit_cap(&Tranche::Junior, &(100 * UNIT));
    assert_eq!(res.unwrap_err(), Ok(PoolError::TimelockActive));
    assert_eq!(pool.client.get_tranche_deposit_cap(&Tranche::Junior), 0);

    // Exactly on the boundary it executes and the pending entry is cleared.
    env.ledger().set_sequence_number(pending.execute_after);
    pool.client
        .set_tranche_deposit_cap(&Tranche::Junior, &(100 * UNIT));
    assert_eq!(
        pool.client.get_tranche_deposit_cap(&Tranche::Junior),
        100 * UNIT
    );
    assert!(pool
        .client
        .get_pending_tranche_cap_change(&Tranche::Junior)
        .is_none());
}

#[test]
fn test_executing_applies_the_queued_value_not_the_new_argument() {
    let env = Env::default();
    let pool = setup(&env);
    pool.client
        .set_tranche_deposit_cap(&Tranche::Junior, &(100 * UNIT));
    advance(&env, pool.client.get_deposit_cap_delay());
    pool.client
        .set_tranche_deposit_cap(&Tranche::Junior, &(999_999 * UNIT));
    assert_eq!(
        pool.client.get_tranche_deposit_cap(&Tranche::Junior),
        100 * UNIT
    );
}

#[test]
fn test_cap_changes_emit_events() {
    let env = Env::default();
    let pool = setup(&env);

    pool.client
        .set_tranche_deposit_cap(&Tranche::Senior, &(100 * UNIT));
    assert!(has_event(&env, "cap_prop"));

    advance(&env, pool.client.get_deposit_cap_delay());
    pool.client
        .set_tranche_deposit_cap(&Tranche::Senior, &(100 * UNIT));
    assert!(has_event(&env, "cap_set"));

    pool.client.set_investor_deposit_cap(&(50 * UNIT));
    assert!(has_event(&env, "cap_prop"));
    advance(&env, pool.client.get_deposit_cap_delay());
    pool.client.set_investor_deposit_cap(&(50 * UNIT));
    assert!(has_event(&env, "cap_set"));
}

#[test]
fn test_cancel_pending_cap_change() {
    let env = Env::default();
    let pool = setup(&env);
    pool.client
        .set_tranche_deposit_cap(&Tranche::Senior, &(100 * UNIT));
    pool.client.cancel_tranche_cap_change(&Tranche::Senior);
    assert!(has_event(&env, "cap_canc"));
    assert!(pool
        .client
        .get_pending_tranche_cap_change(&Tranche::Senior)
        .is_none());

    // With nothing pending, a call proposes afresh rather than executing.
    advance(&env, pool.client.get_deposit_cap_delay() + 1);
    pool.client
        .set_tranche_deposit_cap(&Tranche::Senior, &(100 * UNIT));
    assert_eq!(pool.client.get_tranche_deposit_cap(&Tranche::Senior), 0);

    pool.client.set_investor_deposit_cap(&(50 * UNIT));
    pool.client.cancel_investor_cap_change();
    assert!(pool.client.get_pending_investor_cap_change().is_none());
}

#[test]
fn test_delay_cannot_be_disabled_but_can_be_raised() {
    let env = Env::default();
    let pool = setup(&env);
    let floor = pool.client.get_deposit_cap_delay();

    let res = pool.client.try_set_deposit_cap_delay(&0);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    let res = pool.client.try_set_deposit_cap_delay(&(floor - 1));
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));

    pool.client.set_deposit_cap_delay(&(floor * 5));
    assert_eq!(pool.client.get_deposit_cap_delay(), floor * 5);

    let proposed_at = env.ledger().sequence();
    pool.client.set_investor_deposit_cap(&(10 * UNIT));
    assert_eq!(
        pool.client
            .get_pending_investor_cap_change()
            .unwrap()
            .execute_after,
        proposed_at + floor * 5
    );
}

#[test]
fn test_negative_cap_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let res = pool
        .client
        .try_set_tranche_deposit_cap(&Tranche::Senior, &-1);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
    let res = pool.client.try_set_investor_deposit_cap(&-1);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InvalidAmount));
}
