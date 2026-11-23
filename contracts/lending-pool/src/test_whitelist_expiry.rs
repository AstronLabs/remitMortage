// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for whitelist entries that expire after a configurable validity
//! period: deposits stop at expiry, withdrawals keep working, and renewal
//! restores deposit access.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup};
use soroban_sdk::{testutils::Ledger as _, Env};

const UNIT: i128 = 1_0000000;
const VALIDITY: u64 = 1_000;

fn set_time(env: &Env, timestamp: u64) {
    env.ledger().with_mut(|li| li.timestamp = timestamp);
}

/// A permissioned pool whose default whitelist validity is `VALIDITY` seconds,
/// with ledger time starting at 10_000.
fn permissioned_pool(env: &Env) -> crate::test_support::Pool<'_> {
    set_time(env, 10_000);
    let pool = setup(env);
    pool.client.set_permissioned_mode(&true);
    pool.client.set_default_whitelist_validity(&VALIDITY);
    pool
}

#[test]
fn test_expiry_is_set_from_default_validity() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);

    assert_eq!(pool.client.get_default_whitelist_validity(), VALIDITY);
    pool.client.add_to_whitelist(&investor);
    assert_eq!(
        pool.client.get_whitelist_expiry(&investor),
        Some(10_000 + VALIDITY)
    );
    assert!(pool.client.is_address_whitelisted(&investor));
}

#[test]
fn test_no_default_validity_means_no_expiry() {
    let env = Env::default();
    set_time(&env, 10_000);
    let pool = setup(&env);
    pool.client.set_permissioned_mode(&true);
    let investor = funded(&env, &pool, 100 * UNIT);

    pool.client.add_to_whitelist(&investor);
    assert_eq!(pool.client.get_whitelist_expiry(&investor), None);

    set_time(&env, 10_000_000_000);
    assert!(pool.client.is_address_whitelisted(&investor));
    pool.client.deposit(&investor, &(10 * UNIT), &Tranche::Senior);
}

#[test]
fn test_explicit_expiry_overrides_default() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);

    pool.client.add_to_whitelist_until(&investor, &12_345u64);
    assert_eq!(pool.client.get_whitelist_expiry(&investor), Some(12_345));

    // An expiry that is not in the future is rejected.
    let past = pool.client.try_add_to_whitelist_until(&investor, &10_000u64);
    assert_eq!(past.unwrap_err(), Ok(PoolError::InvalidAmount));
}

#[test]
fn test_deposit_before_expiry_succeeds() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);

    // One second before the entry lapses.
    set_time(&env, 10_000 + VALIDITY - 1);
    pool.client.deposit(&investor, &(40 * UNIT), &Tranche::Senior);
    assert_eq!(pool.client.get_investor_info(&investor).deposited, 40 * UNIT);
}

#[test]
fn test_deposit_after_expiry_is_rejected() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);

    // The expiry timestamp itself is already outside the validity period.
    set_time(&env, 10_000 + VALIDITY);
    assert!(!pool.client.is_address_whitelisted(&investor));
    let result = pool
        .client
        .try_deposit(&investor, &(40 * UNIT), &Tranche::Senior);
    assert_eq!(result.unwrap_err(), Ok(PoolError::Unauthorized));
}

#[test]
fn test_withdrawal_after_expiry_still_works() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);
    pool.client.deposit(&investor, &(100 * UNIT), &Tranche::Senior);

    set_time(&env, 10_000 + VALIDITY + 5_000);
    assert!(!pool.client.is_address_whitelisted(&investor));

    pool.client.withdraw(&investor, &(60 * UNIT));
    assert_eq!(pool.client.get_investor_info(&investor).deposited, 40 * UNIT);
}

#[test]
fn test_withdrawal_still_blocked_once_entry_is_removed() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);
    pool.client.deposit(&investor, &(100 * UNIT), &Tranche::Senior);

    pool.client.remove_from_whitelist(&investor);
    assert_eq!(pool.client.get_whitelist_expiry(&investor), None);
    let result = pool.client.try_withdraw(&investor, &(10 * UNIT));
    assert_eq!(result.unwrap_err(), Ok(PoolError::Unauthorized));
}

#[test]
fn test_renewal_restores_deposit_access() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);

    set_time(&env, 10_000 + VALIDITY + 1);
    assert!(pool
        .client
        .try_deposit(&investor, &(10 * UNIT), &Tranche::Senior)
        .is_err());

    // Renew with the default validity, counted from now.
    pool.client.renew_whitelist(&investor, &None);
    assert_eq!(
        pool.client.get_whitelist_expiry(&investor),
        Some(10_000 + VALIDITY + 1 + VALIDITY)
    );
    assert!(pool.client.is_address_whitelisted(&investor));
    pool.client.deposit(&investor, &(10 * UNIT), &Tranche::Senior);
}

#[test]
fn test_renewal_with_explicit_expiry() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);

    set_time(&env, 20_000);
    pool.client.renew_whitelist(&investor, &Some(50_000u64));
    assert_eq!(pool.client.get_whitelist_expiry(&investor), Some(50_000));

    let stale = pool.client.try_renew_whitelist(&investor, &Some(20_000u64));
    assert_eq!(stale.unwrap_err(), Ok(PoolError::InvalidAmount));
}

#[test]
fn test_renewing_an_unlisted_address_fails() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let stranger = funded(&env, &pool, 100 * UNIT);

    let result = pool.client.try_renew_whitelist(&stranger, &None);
    assert_eq!(result.unwrap_err(), Ok(PoolError::Unauthorized));
}

#[test]
fn test_expiry_config_and_renewal_are_admin_only() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let investor = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&investor);

    // Drop the blanket auth mock so only real authorisations count.
    env.set_auths(&[]);
    assert!(pool
        .client
        .try_renew_whitelist(&investor, &None)
        .is_err());
    assert!(pool.client.try_set_default_whitelist_validity(&5u64).is_err());
    assert!(pool
        .client
        .try_add_to_whitelist_until(&investor, &99_999u64)
        .is_err());
}

#[test]
fn test_loan_request_after_expiry_is_rejected() {
    let env = Env::default();
    let pool = permissioned_pool(&env);
    let borrower = funded(&env, &pool, 100 * UNIT);
    pool.client.add_to_whitelist(&borrower);

    set_time(&env, 10_000 + VALIDITY);
    let loan_id = BytesN::from_array(&env, &[1u8; 32]);
    let result = pool.client.try_request_loan(&borrower, &loan_id, &(10 * UNIT));
    assert_eq!(result.unwrap_err(), Ok(PoolError::Unauthorized));
}
