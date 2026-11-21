// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Every event the pool publishes carries its schema version as the last
//! topic, and (while `EMIT_LEGACY_EVENTS` is set) is also published in its
//! previous shape. The schema-drift guard lives in
//! `contracts/event-schemas/schema.cjs`.

#![cfg(test)]

use super::*;
use crate::events::EMIT_LEGACY_EVENTS;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{testutils::Events as _, xdr::ScVal, BytesN, Env, TryFromVal};

const UNIT: i128 = 1_0000000;
const CURRENT_VERSION: u32 = 1;

fn scval(env: &Env, v: &soroban_sdk::Val) -> ScVal {
    ScVal::try_from_val(env, v).unwrap()
}

/// Checks every event the pool emitted in the last call: each is a versioned
/// copy followed by its legacy copy, and the versioned copy is the legacy
/// topics plus the version. Returns how many events were checked.
fn assert_events_versioned(env: &Env, pool: &Pool<'_>) -> u32 {
    let all = env.events().all();
    let mut mine: Vec<u32> = Vec::new(env);
    for i in 0..all.len() {
        if all.get(i).unwrap().0 == pool.client.address {
            mine.push_back(i);
        }
    }
    let step: u32 = if EMIT_LEGACY_EVENTS { 2 } else { 1 };
    assert_eq!(mine.len() % step, 0);

    let mut checked = 0;
    let mut n = 0;
    while n < mine.len() {
        let (_, topics, data) = all.get(mine.get(n).unwrap()).unwrap();
        let version = u32::try_from_val(env, &topics.last().unwrap())
            .expect("the last topic of every event is its schema version");
        assert_eq!(version, CURRENT_VERSION);

        if EMIT_LEGACY_EVENTS {
            let (_, legacy_topics, legacy_data) = all.get(mine.get(n + 1).unwrap()).unwrap();
            assert_eq!(topics.len(), legacy_topics.len() + 1);
            for i in 0..legacy_topics.len() {
                assert_eq!(
                    scval(env, &topics.get(i).unwrap()),
                    scval(env, &legacy_topics.get(i).unwrap())
                );
            }
            assert_eq!(scval(env, &data), scval(env, &legacy_data));
        }
        checked += 1;
        n += step;
    }
    checked
}

#[test]
fn every_lifecycle_event_carries_its_version_and_a_legacy_copy() {
    let env = Env::default();
    let pool = setup(&env);
    let investor = funded(&env, &pool, 100_000 * UNIT);
    let borrower = funded(&env, &pool, 50_000 * UNIT);
    let loan_id = BytesN::from_array(&env, &[1u8; 32]);

    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);
    assert!(assert_events_versioned(&env, &pool) > 0);

    pool.client
        .request_loan(&borrower, &loan_id, &(10_000 * UNIT));
    assert!(assert_events_versioned(&env, &pool) > 0);

    pool.client.approve_loan(&loan_id);
    assert!(assert_events_versioned(&env, &pool) > 0);

    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &(10_000 * UNIT));
    assert!(assert_events_versioned(&env, &pool) > 0);

    let sched = pool.client.get_repayment_schedule(&loan_id).unwrap();
    pool.client
        .repay(&borrower, &loan_id, &sched.monthly_amount);
    assert!(assert_events_versioned(&env, &pool) > 0);

    // An admin (non-loan) event is versioned too.
    pool.client.set_origination_fee_bps(&100);
    assert!(assert_events_versioned(&env, &pool) > 0);
}

#[test]
fn pause_events_carry_their_version() {
    let env = Env::default();
    let pool = setup(&env);
    pool.client.pause();
    assert!(assert_events_versioned(&env, &pool) > 0);
}

/// No code path may publish an event around `emit_event`: that would emit an
/// unversioned event the indexer cannot tell apart from a legacy one.
#[test]
fn production_code_publishes_only_through_emit_event() {
    let lib = include_str!("lib.rs");
    let production = lib.split("mod test {").next().unwrap();
    assert!(!production.contains(".publish("));
    assert!(!production.contains("events()"));
}
