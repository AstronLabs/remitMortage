// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for per-risk-tier maximum loan term caps.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};
use verification_registry::{VerificationRegistryContract, VerificationRegistryContractClient};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 1_000 * UNIT;

struct Fixture<'a> {
    pool: Pool<'a>,
    registry: VerificationRegistryContractClient<'a>,
}

fn fixture(env: &Env) -> Fixture<'_> {
    let pool = setup(env);
    let investor = funded(env, &pool, 100_000 * UNIT);
    pool.client
        .deposit(&investor, &(100_000 * UNIT), &Tranche::Senior);

    let registry =
        VerificationRegistryContractClient::new(env, &env.register(VerificationRegistryContract, ()));
    registry.initialize(&Address::generate(env));
    pool.client.set_verification_registry(&registry.address);
    Fixture { pool, registry }
}

/// A borrower whose verification score places them in some tier.
fn borrower_with_score(env: &Env, f: &Fixture<'_>, score: u32) -> Address {
    let borrower = Address::generate(env);
    set_score(env, f, &borrower, score);
    borrower
}

fn set_score(env: &Env, f: &Fixture<'_>, borrower: &Address, score: u32) {
    f.registry.register_verification(
        borrower,
        &BytesN::from_array(env, &[(score as u8).max(1); 32]),
        &1_000u32,
        &score,
    );
}

fn loan_id(env: &Env, seed: u8) -> BytesN<32> {
    BytesN::from_array(env, &[seed; 32])
}

#[test]
fn test_tier_is_derived_from_the_verification_score() {
    let env = Env::default();
    let f = fixture(&env);
    for (score, tier) in [
        (90u32, RiskTier::Excellent),
        (70, RiskTier::Good),
        (50, RiskTier::Fair),
        (10, RiskTier::High),
    ] {
        let borrower = borrower_with_score(&env, &f, score);
        assert_eq!(f.pool.client.get_borrower_risk_tier(&borrower), tier);
    }
    // Unverified borrowers are the riskiest tier.
    assert_eq!(
        f.pool.client.get_borrower_risk_tier(&Address::generate(&env)),
        RiskTier::High
    );
}

#[test]
fn test_caps_are_uncapped_by_default_and_readable_without_a_transaction() {
    let env = Env::default();
    let f = fixture(&env);
    assert_eq!(f.pool.client.get_max_loan_term(&RiskTier::High), 0);

    f.pool.client.set_max_loan_term(&RiskTier::High, &6u32);
    f.pool.client.set_max_loan_term(&RiskTier::Excellent, &36u32);
    assert_eq!(f.pool.client.get_max_loan_term(&RiskTier::High), 6);
    assert_eq!(f.pool.client.get_max_loan_term(&RiskTier::Excellent), 36);
    assert_eq!(f.pool.client.get_max_loan_term(&RiskTier::Good), 0);

    let risky = borrower_with_score(&env, &f, 10);
    assert_eq!(f.pool.client.get_borrower_max_loan_term(&risky), 6);
}

#[test]
fn test_term_at_and_over_the_cap_for_each_tier() {
    let env = Env::default();
    let f = fixture(&env);
    let tiers = [
        (RiskTier::Excellent, 90u32, 36u32),
        (RiskTier::Good, 70, 24),
        (RiskTier::Fair, 50, 12),
        (RiskTier::High, 10, 6),
    ];
    for (tier, _, cap) in tiers.iter() {
        f.pool.client.set_max_loan_term(tier, cap);
    }

    for (i, (_, score, cap)) in tiers.iter().enumerate() {
        let borrower = borrower_with_score(&env, &f, *score);
        let seed = (i as u8) * 2 + 1;

        // Exactly at the cap is accepted.
        let at_cap = loan_id(&env, seed);
        f.pool
            .client
            .request_loan_with_term(&borrower, &at_cap, &PRINCIPAL, cap);
        assert_eq!(f.pool.client.get_loan_term(&at_cap), *cap);

        // One month over is rejected with the distinct error.
        let over = loan_id(&env, seed + 1);
        let result = f
            .pool
            .client
            .try_request_loan_with_term(&borrower, &over, &PRINCIPAL, &(cap + 1));
        assert_eq!(result.unwrap_err(), Ok(PoolError::LoanTermExceedsCap));
    }
}

#[test]
fn test_cap_applies_to_the_default_term_request_too() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_loan_term(&RiskTier::High, &6u32);
    let risky = borrower_with_score(&env, &f, 10);

    // `request_loan` uses the default 12-month term, which is over the cap.
    let result = f
        .pool
        .client
        .try_request_loan(&risky, &loan_id(&env, 1), &PRINCIPAL);
    assert_eq!(result.unwrap_err(), Ok(PoolError::LoanTermExceedsCap));

    // A safer borrower is unaffected.
    let safe = borrower_with_score(&env, &f, 90);
    f.pool.client.request_loan(&safe, &loan_id(&env, 2), &PRINCIPAL);
}

#[test]
fn test_zero_term_is_invalid() {
    let env = Env::default();
    let f = fixture(&env);
    let borrower = borrower_with_score(&env, &f, 90);
    let result = f
        .pool
        .client
        .try_request_loan_with_term(&borrower, &loan_id(&env, 1), &PRINCIPAL, &0u32);
    assert_eq!(result.unwrap_err(), Ok(PoolError::InvalidAmount));
}

#[test]
fn test_requested_term_drives_the_repayment_schedule() {
    let env = Env::default();
    let f = fixture(&env);
    let borrower = borrower_with_score(&env, &f, 90);
    let id = loan_id(&env, 1);
    f.pool
        .client
        .request_loan_with_term(&borrower, &id, &PRINCIPAL, &6u32);
    f.pool.client.approve_loan(&id);
    assert_eq!(f.pool.client.get_repayment_schedule(&id).unwrap().duration_months, 6);

    // A plain request keeps the default term.
    let plain = loan_id(&env, 2);
    f.pool.client.request_loan(&borrower, &plain, &PRINCIPAL);
    assert_eq!(f.pool.client.get_loan_term(&plain), DEFAULT_DURATION_MONTHS);
}

#[test]
fn test_tier_change_after_origination_keeps_the_existing_loan_term() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_loan_term(&RiskTier::Excellent, &24u32);
    f.pool.client.set_max_loan_term(&RiskTier::High, &6u32);

    let borrower = borrower_with_score(&env, &f, 90);
    let id = loan_id(&env, 1);
    f.pool
        .client
        .request_loan_with_term(&borrower, &id, &PRINCIPAL, &24u32);
    f.pool.client.approve_loan(&id);

    // The borrower's score drops, moving them to the High tier (cap 6).
    set_score(&env, &f, &borrower, 10);
    assert_eq!(
        f.pool.client.get_borrower_risk_tier(&borrower),
        RiskTier::High
    );

    // The originated loan is untouched...
    assert_eq!(f.pool.client.get_loan_term(&id), 24);
    assert_eq!(f.pool.client.get_repayment_schedule(&id).unwrap().duration_months, 24);

    // ...while a new long request now hits the lower cap.
    let result = f
        .pool
        .client
        .try_request_loan_with_term(&borrower, &loan_id(&env, 2), &PRINCIPAL, &24u32);
    assert_eq!(result.unwrap_err(), Ok(PoolError::LoanTermExceedsCap));
}

#[test]
fn test_removing_a_cap_with_zero() {
    let env = Env::default();
    let f = fixture(&env);
    f.pool.client.set_max_loan_term(&RiskTier::High, &6u32);
    f.pool.client.set_max_loan_term(&RiskTier::High, &0u32);
    let risky = borrower_with_score(&env, &f, 10);
    f.pool
        .client
        .request_loan_with_term(&risky, &loan_id(&env, 1), &PRINCIPAL, &60u32);
}

#[test]
fn test_setting_a_cap_is_admin_only() {
    let env = Env::default();
    let f = fixture(&env);
    env.set_auths(&[]);
    assert!(f
        .pool
        .client
        .try_set_max_loan_term(&RiskTier::High, &6u32)
        .is_err());
    assert_eq!(f.pool.client.get_max_loan_term(&RiskTier::High), 0);
}
