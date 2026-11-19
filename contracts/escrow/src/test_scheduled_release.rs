// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for the optional, admin-confirmed scheduled release date on an
//! escrow goal.

#![cfg(test)]

use crate::test_utils::advance_ledger_time;
use crate::types::{EscrowConfig, ReleaseScheduleLimits};
use crate::{EscrowContract, EscrowContractClient, EscrowError};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

const DAY: u64 = 86_400;
const TARGET: i128 = 10_000_0000000i128;

struct Fixture<'a> {
    client: EscrowContractClient<'a>,
    borrower: Address,
    recipient: Address,
    token: Address,
    goal: Symbol,
}

fn setup(env: &Env) -> Fixture<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 1_000_000;
        li.timestamp = 1_000_000;
    });

    let admin = Address::generate(env);
    let borrower = Address::generate(env);
    let recipient = Address::generate(env);
    let token_admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    StellarAssetClient::new(env, &token).mint(&borrower, &50_000_0000000i128);

    let client = EscrowContractClient::new(env, &env.register(EscrowContract, ()));
    client.initialize(&EscrowConfig {
        admin,
        token: token.clone(),
        lending_pool: Address::generate(env),
        savings_target: TARGET,
        max_duration_ledgers: 518_400u32,
        early_withdrawal_penalty_bps: 500u32,
        min_duration_ledgers: 0u32,
        penalty_bps_tier1: 500u32,
        penalty_bps_tier2: 300u32,
        penalty_bps_tier3: 150u32,
        penalty_bps_tier4: 50u32,
        grace_period_ledgers: 10u32,
        default_penalty_bps: 1000u32,
        instance_bump_amount: 518_400u32,
        instance_lifetime_threshold: 129_600u32,
        persistent_bump_amount: 518_400u32,
        persistent_lifetime_threshold: 129_600u32,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    });

    let goal = Symbol::new(env, "house");
    client.deposit(&borrower, &goal, &TARGET);
    Fixture {
        client,
        borrower,
        recipient,
        token,
        goal,
    }
}

fn now(env: &Env) -> u64 {
    env.ledger().timestamp()
}

fn schedule(env: &Env, f: &Fixture<'_>, release_time: u64) {
    f.client
        .propose_release_time(&f.borrower, &f.goal, &release_time);
    assert_eq!(
        f.client.confirm_release_time(&f.borrower, &f.goal),
        release_time
    );
    let _ = env;
}

// ── Early release attempts ──────────────────────────────────────────────

#[test]
fn test_release_before_scheduled_time_reverts_even_when_target_met() {
    let env = Env::default();
    let f = setup(&env);
    let when = now(&env) + 30 * DAY;
    schedule(&env, &f, when);

    // Target is met, but the date has not arrived.
    let res = f.client.try_release(&f.borrower, &f.goal, &f.recipient);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::ReleaseTimeNotReached));

    // One second before the date still reverts.
    advance_ledger_time(&env, 30 * DAY - 1);
    let res = f.client.try_release(&f.borrower, &f.goal, &f.recipient);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::ReleaseTimeNotReached));
    assert_eq!(
        TokenClient::new(&env, &f.token).balance(&f.recipient),
        0,
        "nothing may move before the scheduled time"
    );
}

#[test]
fn test_release_allowed_at_and_after_scheduled_time() {
    let env = Env::default();
    let f = setup(&env);
    let when = now(&env) + 10 * DAY;
    schedule(&env, &f, when);

    // Exactly on the boundary the release goes through.
    advance_ledger_time(&env, 10 * DAY);
    assert_eq!(now(&env), when);
    let paid = f.client.release(&f.borrower, &f.goal, &f.recipient);
    assert_eq!(paid, TARGET);
    assert_eq!(
        TokenClient::new(&env, &f.token).balance(&f.recipient),
        TARGET
    );

    // The consumed date is cleared.
    assert!(f
        .client
        .get_release_schedule(&f.borrower, &f.goal)
        .is_none());
}

#[test]
fn test_release_after_scheduled_time_passed() {
    let env = Env::default();
    let f = setup(&env);
    schedule(&env, &f, now(&env) + 5 * DAY);
    advance_ledger_time(&env, 20 * DAY);
    assert_eq!(f.client.release(&f.borrower, &f.goal, &f.recipient), TARGET);
}

#[test]
fn test_unconfirmed_proposal_does_not_block_release() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .propose_release_time(&f.borrower, &f.goal, &(now(&env) + 30 * DAY));
    assert!(f
        .client
        .get_release_schedule(&f.borrower, &f.goal)
        .is_none());
    assert!(f
        .client
        .get_pending_release_time(&f.borrower, &f.goal)
        .is_some());

    assert_eq!(f.client.release(&f.borrower, &f.goal, &f.recipient), TARGET);
    assert!(f
        .client
        .get_pending_release_time(&f.borrower, &f.goal)
        .is_none());
}

// ── Goals without a date ────────────────────────────────────────────────

#[test]
fn test_goal_without_date_releases_immediately_as_before() {
    let env = Env::default();
    let f = setup(&env);
    assert!(f
        .client
        .get_release_schedule(&f.borrower, &f.goal)
        .is_none());
    assert_eq!(f.client.release(&f.borrower, &f.goal, &f.recipient), TARGET);
}

#[test]
fn test_goal_without_date_still_requires_target() {
    let env = Env::default();
    let f = setup(&env);
    let other = Symbol::new(&env, "car");
    f.client.deposit(&f.borrower, &other, &(TARGET / 2));
    let res = f.client.try_release(&f.borrower, &other, &f.recipient);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::TargetNotReached));
}

#[test]
fn test_date_on_one_goal_does_not_affect_another() {
    let env = Env::default();
    let f = setup(&env);
    let other = Symbol::new(&env, "car");
    f.client.deposit(&f.borrower, &other, &TARGET);
    schedule(&env, &f, now(&env) + 30 * DAY);

    assert_eq!(f.client.release(&f.borrower, &other, &f.recipient), TARGET);
    let res = f.client.try_release(&f.borrower, &f.goal, &f.recipient);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::ReleaseTimeNotReached));
}

// ── Proposal / confirmation ─────────────────────────────────────────────

#[test]
fn test_confirm_without_proposal_fails() {
    let env = Env::default();
    let f = setup(&env);
    let res = f.client.try_confirm_release_time(&f.borrower, &f.goal);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::NoPendingReleaseTime));
}

#[test]
fn test_propose_rejects_past_and_current_time() {
    let env = Env::default();
    let f = setup(&env);
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &now(&env));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::InvalidReleaseTime));
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &(now(&env) - 1));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::InvalidReleaseTime));
}

#[test]
fn test_propose_requires_existing_goal() {
    let env = Env::default();
    let f = setup(&env);
    let res = f.client.try_propose_release_time(
        &f.borrower,
        &Symbol::new(&env, "nogoal"),
        &(now(&env) + DAY),
    );
    assert_eq!(res.unwrap_err(), Ok(EscrowError::BorrowerNotFound));
}

// ── Rescheduling limits ─────────────────────────────────────────────────

#[test]
fn test_horizon_limit_boundary() {
    let env = Env::default();
    let f = setup(&env);
    let limits = f.client.get_release_schedule_limits();
    let max = limits.max_horizon_secs;

    // Exactly at the horizon is accepted, one second past is not.
    f.client
        .propose_release_time(&f.borrower, &f.goal, &(now(&env) + max));
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &(now(&env) + max + 1));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::InvalidReleaseTime));
}

#[test]
fn test_reschedule_count_limit() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_release_schedule_limits(&ReleaseScheduleLimits {
            max_reschedules: 2,
            min_reschedule_interval_secs: DAY,
            max_horizon_secs: 0,
            max_shift_secs: 0,
        });

    schedule(&env, &f, now(&env) + 100 * DAY);
    for i in 1..=2u64 {
        advance_ledger_time(&env, DAY);
        schedule(&env, &f, now(&env) + (100 + i) * DAY);
    }
    let s = f.client.get_release_schedule(&f.borrower, &f.goal).unwrap();
    assert_eq!(s.reschedule_count, 2);

    // A third reschedule exceeds the limit.
    advance_ledger_time(&env, DAY);
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &(now(&env) + 120 * DAY));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::RescheduleLimitReached));
}

#[test]
fn test_zero_max_reschedules_forbids_changing_a_confirmed_date() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_release_schedule_limits(&ReleaseScheduleLimits {
            max_reschedules: 0,
            min_reschedule_interval_secs: 0,
            max_horizon_secs: 0,
            max_shift_secs: 0,
        });
    schedule(&env, &f, now(&env) + 50 * DAY);
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &(now(&env) + 60 * DAY));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::RescheduleLimitReached));
}

#[test]
fn test_min_reschedule_interval_boundary() {
    let env = Env::default();
    let f = setup(&env);
    schedule(&env, &f, now(&env) + 50 * DAY);

    // One second short of the interval is rejected...
    advance_ledger_time(&env, DAY - 1);
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &(now(&env) + 60 * DAY));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::RescheduleLimitReached));

    // ...and exactly the interval is accepted.
    advance_ledger_time(&env, 1);
    f.client
        .propose_release_time(&f.borrower, &f.goal, &(now(&env) + 60 * DAY));
}

#[test]
fn test_max_shift_limit_boundary_both_directions() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .set_release_schedule_limits(&ReleaseScheduleLimits {
            max_reschedules: 5,
            min_reschedule_interval_secs: 0,
            max_horizon_secs: 0,
            max_shift_secs: 10 * DAY,
        });
    let base = now(&env) + 100 * DAY;
    schedule(&env, &f, base);

    for bad in [base + 10 * DAY + 1, base - 10 * DAY - 1] {
        let res = f
            .client
            .try_propose_release_time(&f.borrower, &f.goal, &bad);
        assert_eq!(res.unwrap_err(), Ok(EscrowError::InvalidReleaseTime));
    }
    // Exactly the maximum shift (earlier) is accepted.
    schedule(&env, &f, base - 10 * DAY);
    assert_eq!(
        f.client
            .get_release_schedule(&f.borrower, &f.goal)
            .unwrap()
            .release_time,
        base - 10 * DAY
    );
}

#[test]
fn test_cannot_reschedule_after_date_has_passed() {
    let env = Env::default();
    let f = setup(&env);
    schedule(&env, &f, now(&env) + 2 * DAY);
    advance_ledger_time(&env, 3 * DAY);
    let res = f
        .client
        .try_propose_release_time(&f.borrower, &f.goal, &(now(&env) + 10 * DAY));
    assert_eq!(res.unwrap_err(), Ok(EscrowError::RescheduleLimitReached));
    // The passed date no longer blocks release.
    assert_eq!(f.client.release(&f.borrower, &f.goal, &f.recipient), TARGET);
}

#[test]
fn test_reschedule_replaces_date_and_blocks_until_new_time() {
    let env = Env::default();
    let f = setup(&env);
    let first = now(&env) + 10 * DAY;
    schedule(&env, &f, first);

    advance_ledger_time(&env, DAY);
    let second = now(&env) + 20 * DAY;
    schedule(&env, &f, second);

    // The old date has no further effect.
    advance_ledger_time(&env, 9 * DAY);
    assert!(now(&env) >= first);
    let res = f.client.try_release(&f.borrower, &f.goal, &f.recipient);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::ReleaseTimeNotReached));

    advance_ledger_time(&env, second - now(&env));
    assert_eq!(f.client.release(&f.borrower, &f.goal, &f.recipient), TARGET);
}

#[test]
fn test_pending_proposal_stays_unconfirmed_if_it_expires_before_confirmation() {
    let env = Env::default();
    let f = setup(&env);
    f.client
        .propose_release_time(&f.borrower, &f.goal, &(now(&env) + 2 * DAY));
    advance_ledger_time(&env, 3 * DAY);
    let res = f.client.try_confirm_release_time(&f.borrower, &f.goal);
    assert_eq!(res.unwrap_err(), Ok(EscrowError::InvalidReleaseTime));
    assert!(f
        .client
        .get_release_schedule(&f.borrower, &f.goal)
        .is_none());
}
