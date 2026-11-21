// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the per-loan event sequence number: every state-changing loan
//! event carries a counter that rises by exactly one, and
//! `get_loan_event_seq` exposes it so an indexer can detect missed events.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    token::StellarAssetClient,
    Address, BytesN, Env, TryFromVal, Val,
};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 10_000 * UNIT;

fn id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

/// Sequence numbers carried by the events logged for `loan_id`, in emission
/// order. An event belongs to the loan when the loan id appears in its topics
/// or payload; the sequence is the last field of its payload tuple.
fn logged_seqs(env: &Env, loan_id: &BytesN<32>) -> Vec<u32> {
    let mut out = Vec::new(env);
    for (_, topics, data) in env.events().all().iter() {
        let payload = match Vec::<Val>::try_from_val(env, &data) {
            Ok(payload) => payload,
            Err(_) => continue,
        };
        let mentions_loan = topics.iter().chain(payload.iter()).any(|v| {
            BytesN::<32>::try_from_val(env, &v)
                .map(|b| &b == loan_id)
                .unwrap_or(false)
        });
        if !mentions_loan {
            continue;
        }
        if let Some(last) = payload.last() {
            if let Ok(seq) = u32::try_from_val(env, &last) {
                out.push_back(seq);
            }
        }
    }
    out
}

/// Asserts that the call just made advanced the loan's sequence and that the
/// events it emitted carry consecutive numbers ending at the read-only
/// counter. Must run before any other contract call (the next call replaces
/// the event log). Returns the new counter.
fn check_step(env: &Env, pool: &Pool<'_>, loan_id: &BytesN<32>, before: u32) -> u32 {
    let seqs = logged_seqs(env, loan_id);
    let after = pool.client.get_loan_event_seq(loan_id);

    assert!(after > before, "a state change must advance the sequence");
    assert!(!seqs.is_empty(), "the call must emit loan events");
    let first = seqs.get(0).unwrap();
    assert!(
        first == before + 1 || first == 1,
        "first event must continue the sequence"
    );
    for i in 1..seqs.len() {
        assert_eq!(
            seqs.get(i).unwrap(),
            seqs.get(i - 1).unwrap() + 1,
            "events must rise by exactly one"
        );
    }
    assert_eq!(seqs.last().unwrap(), after, "counter matches last event");
    after
}

/// What an indexer does: given the sequence numbers it has seen, report
/// whether any are missing or it is behind the on-chain counter.
fn has_gap(seen: &Vec<u32>, on_chain: u32) -> bool {
    let mut expected = 1;
    for seq in seen.iter() {
        if seq != expected {
            return true;
        }
        expected += 1;
    }
    expected - 1 != on_chain
}

fn funded_pool(env: &Env) -> Pool<'_> {
    let pool = setup(env);
    let investor = funded(env, &pool, 200_000 * UNIT);
    pool.client
        .deposit(&investor, &(200_000 * UNIT), &Tranche::Senior);
    pool
}

#[test]
fn unknown_loan_has_sequence_zero() {
    let env = Env::default();
    let pool = setup(&env);
    assert_eq!(pool.client.get_loan_event_seq(&id(&env, 9)), 0);
}

#[test]
fn first_event_is_one_and_each_status_change_adds_one_event() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = funded(&env, &pool, 10 * UNIT);
    let loan_id = id(&env, 1);

    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    // No application fee is configured, so `loan_requested` is the only event.
    let mut seq = check_step(&env, &pool, &loan_id, 0);
    assert_eq!(seq, 1);

    pool.client.approve_loan(&loan_id);
    seq = check_step(&env, &pool, &loan_id, seq);

    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &PRINCIPAL);
    seq = check_step(&env, &pool, &loan_id, seq);
    assert!(seq > 2);
}

#[test]
fn cancel_and_reject_each_advance_the_sequence() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = funded(&env, &pool, 10 * UNIT);

    let cancelled = id(&env, 2);
    pool.client.request_loan(&borrower, &cancelled, &PRINCIPAL);
    let before = check_step(&env, &pool, &cancelled, 0);
    pool.client.cancel_loan(&cancelled);
    check_step(&env, &pool, &cancelled, before);

    let rejected = id(&env, 3);
    pool.client.request_loan(&borrower, &rejected, &PRINCIPAL);
    let before = check_step(&env, &pool, &rejected, 0);
    pool.client.reject_loan(&rejected);
    check_step(&env, &pool, &rejected, before);
}

#[test]
fn repayments_advance_the_sequence_by_one_per_event() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = funded(&env, &pool, 50_000 * UNIT);
    let loan_id = id(&env, 4);

    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &PRINCIPAL);
    let mut seq = pool.client.get_loan_event_seq(&loan_id);

    let sched = pool.client.get_repayment_schedule(&loan_id).unwrap();
    for i in 0..2u32 {
        env.ledger()
            .set_sequence_number(sched.next_due_ledger + i * LEDGERS_PER_MONTH);
        pool.client
            .repay(&borrower, &loan_id, &sched.monthly_amount);
        seq = check_step(&env, &pool, &loan_id, seq);
    }

    pool.client
        .pay_principal(&borrower, &loan_id, &(1_000 * UNIT));
    check_step(&env, &pool, &loan_id, seq);
}

#[test]
fn refinance_advances_the_sequence_by_one_per_event() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = funded(&env, &pool, 50_000 * UNIT);
    let loan_id = id(&env, 5);
    pool.client.set_rate_lock_window_ledgers(&100);

    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &PRINCIPAL);

    // Refinancing needs three on-time payments.
    let sched = pool.client.get_repayment_schedule(&loan_id).unwrap();
    for i in 0..3u32 {
        env.ledger()
            .set_sequence_number(sched.next_due_ledger + i * LEDGERS_PER_MONTH);
        pool.client
            .repay(&borrower, &loan_id, &sched.monthly_amount);
    }
    let request_ledger = sched.next_due_ledger + 3 * LEDGERS_PER_MONTH;
    env.ledger().set_sequence_number(request_ledger);
    StellarAssetClient::new(&env, &pool.token).mint(&borrower, &(10_000 * UNIT));

    let mut seq = pool.client.get_loan_event_seq(&loan_id);
    pool.client.request_refinance(&loan_id, &500u32, &12u32);
    seq = check_step(&env, &pool, &loan_id, seq);

    env.ledger().set_sequence_number(request_ledger + 40);
    pool.client.execute_refinance(&loan_id);
    check_step(&env, &pool, &loan_id, seq);
}

#[test]
fn sequences_are_independent_per_loan() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = funded(&env, &pool, 10 * UNIT);
    let first = id(&env, 6);
    let second = id(&env, 7);

    pool.client.request_loan(&borrower, &first, &PRINCIPAL);
    pool.client.approve_loan(&first);
    let first_seq = pool.client.get_loan_event_seq(&first);
    assert!(first_seq >= 2);

    pool.client.request_loan(&borrower, &second, &PRINCIPAL);
    assert_eq!(pool.client.get_loan_event_seq(&second), 1);
    assert_eq!(pool.client.get_loan_event_seq(&first), first_seq);
}

#[test]
fn indexer_detects_a_missed_event_by_comparing_to_the_counter() {
    let env = Env::default();
    let pool = funded_pool(&env);
    let borrower = funded(&env, &pool, 10 * UNIT);
    let loan_id = id(&env, 8);

    // Each call below replaces the event log, so gather what an indexer
    // would have seen as it goes.
    let mut stream: Vec<u32> = Vec::new(&env);
    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    for s in logged_seqs(&env, &loan_id).iter() {
        stream.push_back(s);
    }
    pool.client.approve_loan(&loan_id);
    for s in logged_seqs(&env, &loan_id).iter() {
        stream.push_back(s);
    }
    pool.client.cancel_loan(&loan_id);
    for s in logged_seqs(&env, &loan_id).iter() {
        stream.push_back(s);
    }
    let on_chain = pool.client.get_loan_event_seq(&loan_id);

    // A complete stream matches the counter.
    assert!(!has_gap(&stream, on_chain));

    // Dropping an event from the middle leaves a hole.
    let mut missing_middle: Vec<u32> = Vec::new(&env);
    for (i, s) in stream.iter().enumerate() {
        if i != 1 {
            missing_middle.push_back(s);
        }
    }
    assert!(has_gap(&missing_middle, on_chain));

    // Missing the most recent event leaves the indexer behind the counter.
    let mut missing_tail: Vec<u32> = Vec::new(&env);
    for i in 0..stream.len() - 1 {
        missing_tail.push_back(stream.get(i).unwrap());
    }
    assert!(has_gap(&missing_tail, on_chain));
}
