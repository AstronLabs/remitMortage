// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for borrower-authorized recurring escrow auto-deposits (#635).

#![cfg(test)]

use crate::errors::EscrowError;
use crate::types::{AutoDepositSchedule, EscrowConfig};
use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

const AMOUNT: i128 = 500_0000000;
const INTERVAL: u32 = 100;

fn base_config(admin: Address, token: Address, lending_pool: Address) -> EscrowConfig {
    EscrowConfig {
        admin,
        token,
        lending_pool,
        savings_target: 10_000_0000000i128,
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
        permissioned_mode: false,
    }
}

struct Setup<'a> {
    env: Env,
    client: EscrowContractClient<'a>,
    token: TokenClient<'a>,
    borrower: Address,
    goal: Symbol,
}

fn setup<'a>() -> Setup<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.sequence_number = 1_000;
        li.max_entry_ttl = 1_000_000;
    });

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    StellarAssetClient::new(&env, &token_address).mint(&borrower, &(AMOUNT * 10));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(&env, &contract_id);
    client.initialize(&base_config(
        admin,
        token_address.clone(),
        Address::generate(&env),
    ));

    let token = TokenClient::new(&env, &token_address);
    let goal = Symbol::new(&env, "house");
    Setup {
        env,
        client,
        token,
        borrower,
        goal,
    }
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| li.sequence_number += ledgers);
}

fn approve(s: &Setup, amount: i128) {
    s.token.approve(
        &s.borrower,
        &s.client.address,
        &amount,
        &(s.env.ledger().sequence() + 10_000),
    );
}

#[test]
fn test_configure_stores_schedule_due_one_interval_later() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);

    assert_eq!(
        s.client.get_auto_deposit(&s.borrower, &s.goal),
        Some(AutoDepositSchedule {
            amount: AMOUNT,
            interval_ledgers: INTERVAL,
            next_execution_ledger: 1_000 + INTERVAL,
        })
    );
    // Configuring alone moves no funds.
    assert_eq!(s.client.get_balance(&s.borrower, &s.goal), 0);
}

#[test]
fn test_configure_rejects_invalid_amount_and_interval() {
    let s = setup();
    assert_eq!(
        s.client
            .try_configure_auto_deposit(&s.borrower, &s.goal, &0, &INTERVAL),
        Err(Ok(EscrowError::InvalidAmount))
    );
    assert_eq!(
        s.client
            .try_configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &0),
        Err(Ok(EscrowError::InvalidAutoDepositInterval))
    );
    assert_eq!(s.client.get_auto_deposit(&s.borrower, &s.goal), None);
}

#[test]
fn test_configure_requires_borrower_auth() {
    let s = setup();
    s.env.set_auths(&[]);
    assert!(s
        .client
        .try_configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL)
        .is_err());
}

#[test]
fn test_executes_once_interval_elapsed_with_allowance() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);
    approve(&s, AMOUNT * 3);
    let borrower_before = s.token.balance(&s.borrower);

    advance(&s.env, INTERVAL);
    // Permissionless: no auths are mocked for the keeper's call.
    s.env.set_auths(&[]);
    let deposited = s.client.execute_auto_deposit(&s.borrower, &s.goal);

    assert_eq!(deposited, AMOUNT);
    assert_eq!(s.client.get_balance(&s.borrower, &s.goal), AMOUNT);
    assert_eq!(s.client.get_total_pooled(), AMOUNT);
    assert_eq!(s.token.balance(&s.borrower), borrower_before - AMOUNT);
    assert_eq!(s.token.balance(&s.client.address), AMOUNT);
    assert_eq!(
        s.token.allowance(&s.borrower, &s.client.address),
        AMOUNT * 2
    );
    assert_eq!(
        s.client
            .get_auto_deposit(&s.borrower, &s.goal)
            .unwrap()
            .next_execution_ledger,
        s.env.ledger().sequence() + INTERVAL
    );

    // The following interval draws again.
    advance(&s.env, INTERVAL);
    assert_eq!(
        s.client.execute_auto_deposit(&s.borrower, &s.goal),
        AMOUNT * 2
    );
}

#[test]
fn test_early_execution_rejected_without_side_effects() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);
    approve(&s, AMOUNT * 3);
    let schedule = s.client.get_auto_deposit(&s.borrower, &s.goal);
    let borrower_before = s.token.balance(&s.borrower);

    advance(&s.env, INTERVAL - 1);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::AutoDepositNotDue))
    );

    // Right after a successful draw, the next one is not yet due either.
    advance(&s.env, 1);
    s.client.execute_auto_deposit(&s.borrower, &s.goal);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::AutoDepositNotDue))
    );

    assert_eq!(s.client.get_balance(&s.borrower, &s.goal), AMOUNT);
    assert_eq!(s.token.balance(&s.borrower), borrower_before - AMOUNT);
    assert_ne!(s.client.get_auto_deposit(&s.borrower, &s.goal), schedule);
}

#[test]
fn test_late_keeper_cannot_fire_catch_up_draws() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);
    approve(&s, AMOUNT * 5);

    advance(&s.env, INTERVAL * 3);
    s.client.execute_auto_deposit(&s.borrower, &s.goal);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::AutoDepositNotDue))
    );
    assert_eq!(s.client.get_balance(&s.borrower, &s.goal), AMOUNT);
}

#[test]
fn test_insufficient_allowance_rejected_without_side_effects() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);
    approve(&s, AMOUNT - 1);
    let schedule = s.client.get_auto_deposit(&s.borrower, &s.goal);
    let borrower_before = s.token.balance(&s.borrower);

    advance(&s.env, INTERVAL);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::InsufficientAllowance))
    );

    assert_eq!(s.client.get_balance(&s.borrower, &s.goal), 0);
    assert_eq!(s.client.get_total_pooled(), 0);
    assert_eq!(s.token.balance(&s.borrower), borrower_before);
    assert_eq!(
        s.token.allowance(&s.borrower, &s.client.address),
        AMOUNT - 1
    );
    assert_eq!(s.client.get_auto_deposit(&s.borrower, &s.goal), schedule);

    // Once the borrower approves enough, the same due draw goes through.
    approve(&s, AMOUNT);
    assert_eq!(s.client.execute_auto_deposit(&s.borrower, &s.goal), AMOUNT);
}

#[test]
fn test_without_any_allowance_is_rejected() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);
    advance(&s.env, INTERVAL);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::InsufficientAllowance))
    );
}

#[test]
fn test_insufficient_balance_rejected_without_side_effects() {
    let s = setup();
    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &(AMOUNT * 20), &INTERVAL);
    approve(&s, AMOUNT * 20);

    advance(&s.env, INTERVAL);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::InsufficientBalance))
    );
    assert_eq!(s.client.get_balance(&s.borrower, &s.goal), 0);
    assert_eq!(s.token.balance(&s.borrower), AMOUNT * 10);
}

#[test]
fn test_execute_without_schedule_and_cancel() {
    let s = setup();
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::AutoDepositNotConfigured))
    );
    assert_eq!(
        s.client.try_cancel_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::AutoDepositNotConfigured))
    );

    s.client
        .configure_auto_deposit(&s.borrower, &s.goal, &AMOUNT, &INTERVAL);
    approve(&s, AMOUNT);
    s.client.cancel_auto_deposit(&s.borrower, &s.goal);
    assert_eq!(s.client.get_auto_deposit(&s.borrower, &s.goal), None);

    advance(&s.env, INTERVAL);
    assert_eq!(
        s.client.try_execute_auto_deposit(&s.borrower, &s.goal),
        Err(Ok(EscrowError::AutoDepositNotConfigured))
    );
}
