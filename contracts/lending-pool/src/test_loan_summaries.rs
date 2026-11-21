// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for `get_loan_summaries`: the batched, read-only loan view used by
//! indexers to rebuild state without one contract call per loan.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{testutils::Address as _, BytesN, Env};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 1_000 * UNIT;

/// Requests a loan for a fresh borrower. The id is derived from `n` so any
/// number of distinct loans can be created.
fn request(env: &Env, pool: &Pool<'_>, n: u32) -> (Address, BytesN<32>) {
    let mut bytes = [0u8; 32];
    bytes[..4].copy_from_slice(&n.to_be_bytes());
    bytes[31] = 1;
    let loan_id = BytesN::from_array(env, &bytes);
    let borrower = Address::generate(env);
    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    (borrower, loan_id)
}

fn request_many(env: &Env, pool: &Pool<'_>, count: u32) -> Vec<BytesN<32>> {
    let mut ids = Vec::new(env);
    for n in 0..count {
        ids.push_back(request(env, pool, n).1);
    }
    ids
}

#[test]
fn empty_range_returns_empty_page() {
    let env = Env::default();
    let pool = setup(&env);

    let page = pool.client.get_loan_summaries(&0, &10);
    assert_eq!(page.summaries.len(), 0);
    assert_eq!(page.next_start_id, 0);
    assert_eq!(page.total, 0);
}

#[test]
fn zero_limit_returns_empty_page_without_advancing() {
    let env = Env::default();
    let pool = setup(&env);
    request_many(&env, &pool, 3);

    let page = pool.client.get_loan_summaries(&1, &0);
    assert_eq!(page.summaries.len(), 0);
    assert_eq!(page.next_start_id, 1);
    assert_eq!(page.total, 3);
}

#[test]
fn full_page_returns_limit_summaries_and_cursor() {
    let env = Env::default();
    let pool = setup(&env);
    let ids = request_many(&env, &pool, 5);

    let page = pool.client.get_loan_summaries(&0, &3);
    assert_eq!(page.summaries.len(), 3);
    assert_eq!(page.next_start_id, 3);
    assert_eq!(page.total, 5);
    for i in 0..3u32 {
        let s = page.summaries.get(i).unwrap();
        assert_eq!(s.index, i);
        assert_eq!(s.loan_id, ids.get(i).unwrap());
    }
}

#[test]
fn cursor_walks_the_whole_index_in_creation_order() {
    let env = Env::default();
    let pool = setup(&env);
    let ids = request_many(&env, &pool, 7);

    let mut seen: Vec<BytesN<32>> = Vec::new(&env);
    let mut cursor = 0u32;
    loop {
        let page = pool.client.get_loan_summaries(&cursor, &3);
        for s in page.summaries.iter() {
            seen.push_back(s.loan_id);
        }
        if page.next_start_id >= page.total {
            break;
        }
        cursor = page.next_start_id;
    }
    assert_eq!(seen, ids);
}

#[test]
fn last_page_is_short_and_cursor_reaches_total() {
    let env = Env::default();
    let pool = setup(&env);
    let ids = request_many(&env, &pool, 5);

    let page = pool.client.get_loan_summaries(&3, &10);
    assert_eq!(page.summaries.len(), 2);
    assert_eq!(page.next_start_id, 5);
    assert_eq!(page.total, 5);
    assert_eq!(page.summaries.get(0).unwrap().loan_id, ids.get(3).unwrap());
    assert_eq!(page.summaries.get(1).unwrap().loan_id, ids.get(4).unwrap());
}

#[test]
fn start_id_past_the_end_returns_empty_page() {
    let env = Env::default();
    let pool = setup(&env);
    request_many(&env, &pool, 5);

    let page = pool.client.get_loan_summaries(&5, &10);
    assert_eq!(page.summaries.len(), 0);
    assert_eq!(page.next_start_id, 5);

    let page = pool.client.get_loan_summaries(&u32::MAX, &u32::MAX);
    assert_eq!(page.summaries.len(), 0);
    assert_eq!(page.next_start_id, 5);
    assert_eq!(page.total, 5);
}

#[test]
fn page_size_is_capped() {
    let env = Env::default();
    let pool = setup(&env);
    request_many(&env, &pool, MAX_LOAN_SUMMARY_PAGE + 2);

    let page = pool.client.get_loan_summaries(&0, &u32::MAX);
    assert_eq!(page.summaries.len(), MAX_LOAN_SUMMARY_PAGE);
    assert_eq!(page.next_start_id, MAX_LOAN_SUMMARY_PAGE);
    assert_eq!(page.total, MAX_LOAN_SUMMARY_PAGE + 2);

    // The cursor picks up exactly where the capped page stopped.
    let rest = pool.client.get_loan_summaries(&page.next_start_id, &u32::MAX);
    assert_eq!(rest.summaries.len(), 2);
    assert_eq!(rest.next_start_id, MAX_LOAN_SUMMARY_PAGE + 2);
}

#[test]
fn summary_carries_status_principal_due_date_and_borrower() {
    let env = Env::default();
    let pool = setup(&env);

    let investor = funded(&env, &pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);

    let (requested_borrower, requested_id) = request(&env, &pool, 1);
    let (approved_borrower, approved_id) = request(&env, &pool, 2);
    pool.client.approve_loan(&approved_id);
    pool.client.add_contractor(&approved_borrower);
    pool.client
        .disburse(&approved_id, &approved_borrower, &PRINCIPAL);

    // Requested loan: no schedule yet, so no due date.
    let page = pool.client.get_loan_summaries(&0, &10);
    let first = page.summaries.get(0).unwrap();
    assert_eq!(first.loan_id, requested_id);
    assert_eq!(first.borrower, requested_borrower);
    assert_eq!(first.status, LoanStatus::Requested);
    assert_eq!(first.outstanding_principal, PRINCIPAL);
    assert_eq!(first.next_due_ledger, 0);

    // Approved loan: schedule exists, so the due date matches it.
    let second = page.summaries.get(1).unwrap();
    let sched = pool.client.get_repayment_schedule(&approved_id).unwrap();
    assert_eq!(second.loan_id, approved_id);
    assert_eq!(second.borrower, approved_borrower);
    assert_eq!(second.status, LoanStatus::Approved);
    assert_eq!(second.outstanding_principal, PRINCIPAL);
    assert_eq!(second.next_due_ledger, sched.next_due_ledger);
    assert!(second.next_due_ledger > 0);

    // Paying principal lowers the reported outstanding principal.
    pool.client
        .pay_principal(&approved_borrower, &approved_id, &(400 * UNIT));
    let page = pool.client.get_loan_summaries(&1, &1);
    assert_eq!(
        page.summaries.get(0).unwrap().outstanding_principal,
        PRINCIPAL - 400 * UNIT
    );
}

#[test]
fn cancelled_loans_keep_their_index_slot() {
    let env = Env::default();
    let pool = setup(&env);
    let (_, first_id) = request(&env, &pool, 1);
    let (_, second_id) = request(&env, &pool, 2);
    pool.client.cancel_loan(&first_id);

    let page = pool.client.get_loan_summaries(&0, &10);
    assert_eq!(page.total, 2);
    assert_eq!(page.summaries.get(0).unwrap().loan_id, first_id);
    assert_eq!(page.summaries.get(0).unwrap().status, LoanStatus::Cancelled);
    assert_eq!(page.summaries.get(1).unwrap().loan_id, second_id);
}

#[test]
fn reading_summaries_does_not_modify_state() {
    let env = Env::default();
    let pool = setup(&env);
    let (_, loan_id) = request(&env, &pool, 1);

    let loan_before = pool.client.get_loan_info(&loan_id);
    let liquidity_before = pool.client.get_liquidity();
    let first = pool.client.get_loan_summaries(&0, &10);

    // Repeating the read gives the identical page, and no loan or pool
    // figure moved.
    let second = pool.client.get_loan_summaries(&0, &10);
    assert_eq!(first, second);
    assert_eq!(pool.client.get_loan_info(&loan_id), loan_before);
    assert_eq!(pool.client.get_liquidity(), liquidity_before);
    assert_eq!(first.total, 1);
}
