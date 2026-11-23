// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the two-step admin transfer: propose, accept, expire, cancel and
//! replace.

#![cfg(test)]

use super::*;
use crate::test_support::setup;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

const START: u64 = 10_000;

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| li.timestamp = timestamp);
}

#[test]
fn test_admin_does_not_change_until_accepted() {
    let env = Env::default();
    set_time(&env, START);
    let pool = setup(&env);
    let new_admin = Address::generate(&env);

    pool.client.propose_new_admin(&new_admin);
    assert_eq!(pool.client.get_pool_config().admin, pool.admin);
    assert_eq!(pool.client.get_pending_admin(), Some(new_admin.clone()));
    assert_eq!(
        pool.client.get_pending_admin_expiry(),
        Some(START + DEFAULT_ADMIN_TRANSFER_WINDOW_SECS)
    );

    pool.client.accept_admin();
    assert_eq!(pool.client.get_pool_config().admin, new_admin);
    assert_eq!(pool.client.get_pending_admin(), None);
    assert_eq!(pool.client.get_pending_admin_expiry(), None);
}

#[test]
fn test_acceptance_by_the_wrong_address_is_rejected() {
    let env = Env::default();
    let pool = setup(&env);
    let proposed = Address::generate(&env);
    let intruder = Address::generate(&env);
    pool.client.propose_new_admin(&proposed);

    // Only the intruder authorises the call; the proposed address does not.
    env.set_auths(&[]);
    let result = pool
        .client
        .mock_auths(&[MockAuth {
            address: &intruder,
            invoke: &MockAuthInvoke {
                contract: &pool.client.address,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_accept_admin();
    assert!(result.is_err());
    assert_eq!(pool.client.get_pool_config().admin, pool.admin);
    assert_eq!(pool.client.get_pending_admin(), Some(proposed));
}

#[test]
fn test_expired_proposal_cannot_be_accepted() {
    let env = Env::default();
    set_time(&env, START);
    let pool = setup(&env);
    let new_admin = Address::generate(&env);
    pool.client.set_admin_transfer_window(&1_000u64);
    pool.client.propose_new_admin(&new_admin);

    // Still acceptable one second before expiry.
    set_time(&env, START + 999);
    assert_eq!(pool.client.get_pending_admin(), Some(new_admin.clone()));

    // At the expiry timestamp the proposal is dead.
    set_time(&env, START + 1_000);
    assert_eq!(pool.client.get_pending_admin(), None);
    let result = pool.client.try_accept_admin();
    assert_eq!(result.unwrap_err(), Ok(PoolError::NotPendingAdmin));
    assert_eq!(pool.client.get_pool_config().admin, pool.admin);
}

#[test]
fn test_cancelled_proposal_cannot_be_accepted() {
    let env = Env::default();
    let pool = setup(&env);
    let new_admin = Address::generate(&env);
    pool.client.propose_new_admin(&new_admin);

    pool.client.cancel_admin_transfer();
    assert_eq!(pool.client.get_pending_admin(), None);
    let result = pool.client.try_accept_admin();
    assert_eq!(result.unwrap_err(), Ok(PoolError::NotPendingAdmin));
    assert_eq!(pool.client.get_pool_config().admin, pool.admin);

    // Nothing left to cancel.
    let again = pool.client.try_cancel_admin_transfer();
    assert_eq!(again.unwrap_err(), Ok(PoolError::NotPendingAdmin));
}

#[test]
fn test_new_proposal_replaces_the_old_one() {
    let env = Env::default();
    set_time(&env, START);
    let pool = setup(&env);
    pool.client.set_admin_transfer_window(&1_000u64);
    let first = Address::generate(&env);
    let second = Address::generate(&env);

    pool.client.propose_new_admin(&first);
    set_time(&env, START + 600);
    pool.client.propose_new_admin(&second);

    // The window restarts from the second proposal.
    assert_eq!(pool.client.get_pending_admin(), Some(second.clone()));
    assert_eq!(pool.client.get_pending_admin_expiry(), Some(START + 600 + 1_000));

    // Only the second address can accept; the first is no longer pending.
    pool.client.accept_admin();
    assert_eq!(pool.client.get_pool_config().admin, second);
    assert_eq!(
        pool.client.try_accept_admin().unwrap_err(),
        Ok(PoolError::NotPendingAdmin)
    );
}

#[test]
fn test_reproposing_after_expiry_works() {
    let env = Env::default();
    set_time(&env, START);
    let pool = setup(&env);
    pool.client.set_admin_transfer_window(&100u64);
    let new_admin = Address::generate(&env);

    pool.client.propose_new_admin(&new_admin);
    set_time(&env, START + 500);
    assert!(pool.client.try_accept_admin().is_err());

    pool.client.propose_new_admin(&new_admin);
    pool.client.accept_admin();
    assert_eq!(pool.client.get_pool_config().admin, new_admin);
}

#[test]
fn test_window_config_is_validated_and_admin_only() {
    let env = Env::default();
    let pool = setup(&env);
    assert_eq!(
        pool.client.get_admin_transfer_window(),
        DEFAULT_ADMIN_TRANSFER_WINDOW_SECS
    );
    assert_eq!(
        pool.client.try_set_admin_transfer_window(&0u64).unwrap_err(),
        Ok(PoolError::InvalidAmount)
    );
    pool.client.set_admin_transfer_window(&3_600u64);
    assert_eq!(pool.client.get_admin_transfer_window(), 3_600);

    env.set_auths(&[]);
    assert!(pool.client.try_set_admin_transfer_window(&10u64).is_err());
    assert!(pool.client.try_cancel_admin_transfer().is_err());
}

#[test]
fn test_only_the_current_admin_can_propose() {
    let env = Env::default();
    let pool = setup(&env);
    env.set_auths(&[]);
    assert!(pool
        .client
        .try_propose_new_admin(&Address::generate(&env))
        .is_err());
}
