// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the per-borrower cooldown after a rejected or cancelled loan
//! request.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 1_000 * UNIT;
const START: u64 = 10_000;
const COOLDOWN: u64 = 3_600;

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| li.timestamp = timestamp);
}

fn loan_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

/// A funded pool with the cooldown enabled and a borrower whose first request
/// (`seed` 1) has just been rejected at `START`.
fn rejected_borrower(env: &Env) -> (Pool<'_>, Address) {
    set_time(env, START);
    let pool = setup(env);
    let investor = funded(env, &pool, 100_000 * UNIT);
    pool.client.deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);
    pool.client.set_loan_request_cooldown(&COOLDOWN);

    let borrower = Address::generate(env);
    pool.client.request_loan(&borrower, &loan_id(env, 1), &PRINCIPAL);
    pool.client.reject_loan(&loan_id(env, 1));
    (pool, borrower)
}

#[test]
fn test_no_cooldown_by_default() {
    let env = Env::default();
    set_time(&env, START);
    let pool = setup(&env);
    assert_eq!(pool.client.get_loan_request_cooldown(), 0);

    let borrower = Address::generate(&env);
    pool.client.request_loan(&borrower, &loan_id(&env, 1), &PRINCIPAL);
    pool.client.reject_loan(&loan_id(&env, 1));
    pool.client.request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL);
}

#[test]
fn test_request_during_cooldown_after_rejection_is_rejected() {
    let env = Env::default();
    let (pool, borrower) = rejected_borrower(&env);

    set_time(&env, START + COOLDOWN - 1);
    let result = pool
        .client
        .try_request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL);
    assert_eq!(result.unwrap_err(), Ok(PoolError::LoanRequestCooldownActive));
    assert_eq!(
        pool.client.get_loan_request_cooldown_end(&borrower),
        Some(START + COOLDOWN)
    );
}

#[test]
fn test_every_request_path_honours_the_cooldown() {
    let env = Env::default();
    let (pool, borrower) = rejected_borrower(&env);
    let escrow_origin = Address::generate(&env);

    let a = pool
        .client
        .try_request_loan_with_origin(&borrower, &loan_id(&env, 2), &PRINCIPAL, &escrow_origin);
    let b = pool
        .client
        .try_request_loan_with_term(&borrower, &loan_id(&env, 3), &PRINCIPAL, &6u32);
    let c = pool
        .client
        .try_request_loan_with_note(&borrower, &loan_id(&env, 4), &PRINCIPAL, &None);
    for result in [a, b, c] {
        assert_eq!(result.unwrap_err(), Ok(PoolError::LoanRequestCooldownActive));
    }
}

#[test]
fn test_request_during_cooldown_after_cancellation_is_rejected() {
    let env = Env::default();
    set_time(&env, START);
    let pool = setup(&env);
    pool.client.set_loan_request_cooldown(&COOLDOWN);

    let borrower = Address::generate(&env);
    pool.client.request_loan(&borrower, &loan_id(&env, 1), &PRINCIPAL);
    pool.client.cancel_loan(&loan_id(&env, 1));

    set_time(&env, START + 10);
    let result = pool
        .client
        .try_request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL);
    assert_eq!(result.unwrap_err(), Ok(PoolError::LoanRequestCooldownActive));
}

#[test]
fn test_request_after_cooldown_succeeds() {
    let env = Env::default();
    let (pool, borrower) = rejected_borrower(&env);

    // The cooldown ends exactly at `START + COOLDOWN`.
    set_time(&env, START + COOLDOWN);
    assert_eq!(pool.client.get_loan_request_cooldown_end(&borrower), None);
    pool.client.request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL);
    assert_eq!(
        pool.client.get_loan_info(&loan_id(&env, 2)).status,
        LoanStatus::Requested
    );
}

#[test]
fn test_admin_can_clear_a_cooldown() {
    let env = Env::default();
    let (pool, borrower) = rejected_borrower(&env);

    set_time(&env, START + 1);
    assert!(pool
        .client
        .try_request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL)
        .is_err());

    pool.client.clear_loan_request_cooldown(&borrower);
    assert_eq!(pool.client.get_loan_request_cooldown_end(&borrower), None);
    pool.client.request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL);
}

#[test]
fn test_only_the_admin_can_clear_a_cooldown() {
    let env = Env::default();
    let (pool, borrower) = rejected_borrower(&env);

    env.set_auths(&[]);
    assert!(pool
        .client
        .try_clear_loan_request_cooldown(&borrower)
        .is_err());
    assert!(pool.client.try_set_loan_request_cooldown(&1u64).is_err());
    assert_eq!(
        pool.client.get_loan_request_cooldown_end(&borrower),
        Some(START + COOLDOWN)
    );
}

#[test]
fn test_a_different_borrower_is_unaffected() {
    let env = Env::default();
    let (pool, _rejected) = rejected_borrower(&env);

    let other = Address::generate(&env);
    pool.client.request_loan(&other, &loan_id(&env, 9), &PRINCIPAL);
    assert_eq!(pool.client.get_loan_request_cooldown_end(&other), None);
}

#[test]
fn test_a_new_rejection_restarts_the_cooldown() {
    let env = Env::default();
    let (pool, borrower) = rejected_borrower(&env);

    set_time(&env, START + COOLDOWN);
    pool.client.request_loan(&borrower, &loan_id(&env, 2), &PRINCIPAL);
    pool.client.reject_loan(&loan_id(&env, 2));

    assert_eq!(
        pool.client.get_loan_request_cooldown_end(&borrower),
        Some(START + 2 * COOLDOWN)
    );
}
