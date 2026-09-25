// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for direct escrow-to-escrow goal consolidation (#617).

#![cfg(test)]

use crate::types::{BorrowerRecord, DataKey, EscrowConfig};
use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

fn base_config(
    admin: Address,
    token: Address,
    lending_pool: Address,
    min_duration_ledgers: u32,
) -> EscrowConfig {
    EscrowConfig {
        admin,
        token,
        lending_pool,
        savings_target: 10_000_0000000i128,
        max_duration_ledgers: 518_400u32,
        early_withdrawal_penalty_bps: 500u32,
        min_duration_ledgers,
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

fn setup(env: &Env) -> (EscrowContractClient<'_>, Address, Address, Address, Address) {
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 1_000_000;
    });

    let admin = Address::generate(env);
    let borrower = Address::generate(env);
    let lending_pool = Address::generate(env);

    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_id.address();
    StellarAssetClient::new(env, &token_address).mint(&borrower, &50_000_0000000i128);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    (client, admin, borrower, token_address, lending_pool)
}

fn read_record(
    env: &Env,
    client: &EscrowContractClient<'_>,
    borrower: &Address,
    goal: &Symbol,
) -> BorrowerRecord {
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .get(&DataKey::Borrower(borrower.clone(), goal.clone()))
            .unwrap()
    })
}

/// Consolidating a goal moves its full balance into the destination without an
/// intermediate withdrawal or any external token transfer.
#[test]
fn consolidating_goals_moves_full_balance_without_withdrawal() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), lending_pool, 0));

    let from_goal = Symbol::new(&env, "secondary");
    let to_goal = Symbol::new(&env, "primary");
    client.deposit(&borrower, &from_goal, &600);
    client.deposit(&borrower, &to_goal, &400);

    let token = TokenClient::new(&env, &token_address);
    let contract_balance_before = token.balance(&client.address);
    let borrower_balance_before = token.balance(&borrower);

    client.transfer_between_goals(&borrower, &from_goal, &to_goal, &600);

    assert_eq!(client.get_borrower_balance(&borrower, &from_goal), 0);
    assert_eq!(client.get_borrower_balance(&borrower, &to_goal), 1000);
    assert_eq!(client.get_total_pooled(), 1000);

    // Funds never left the contract and the borrower received no refund.
    assert_eq!(token.balance(&client.address), contract_balance_before);
    assert_eq!(token.balance(&borrower), borrower_balance_before);

    let from_record = read_record(&env, &client, &borrower, &from_goal);
    assert!(
        !from_record.withdrawn,
        "consolidation must not mark an early withdrawal"
    );
}

/// A partial transfer moves only the requested amount, leaving the remainder in
/// the source goal.
#[test]
fn partial_transfer_moves_only_requested_amount() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), lending_pool, 0));

    let from_goal = Symbol::new(&env, "secondary");
    let to_goal = Symbol::new(&env, "primary");
    client.deposit(&borrower, &from_goal, &1000);
    client.deposit(&borrower, &to_goal, &250);

    client.transfer_between_goals(&borrower, &from_goal, &to_goal, &400);

    assert_eq!(client.get_borrower_balance(&borrower, &from_goal), 600);
    assert_eq!(client.get_borrower_balance(&borrower, &to_goal), 650);
    assert_eq!(client.get_total_pooled(), 1250);
}

/// Moving an older goal's balance into a newer goal preserves the older lockup
/// start on the destination, so consolidation cannot reset the lockup timer.
#[test]
fn consolidation_preserves_earliest_lockup_start() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(
        admin,
        token_address.clone(),
        lending_pool,
        300,
    ));

    let older_goal = Symbol::new(&env, "older");
    let newer_goal = Symbol::new(&env, "newer");

    // Older goal is opened at the current ledger.
    client.deposit(&borrower, &older_goal, &500);
    let older_start = read_record(&env, &client, &borrower, &older_goal).start_ledger;

    // Newer goal is opened well after.
    env.ledger().with_mut(|li| {
        li.sequence_number += 250;
    });
    client.deposit(&borrower, &newer_goal, &500);
    let newer_start = read_record(&env, &client, &borrower, &newer_goal).start_ledger;
    assert!(newer_start > older_start);

    // Consolidate the older goal into the newer one.
    client.transfer_between_goals(&borrower, &older_goal, &newer_goal, &500);

    let dest = read_record(&env, &client, &borrower, &newer_goal);
    assert_eq!(
        dest.start_ledger, older_start,
        "destination lockup must inherit the earliest start ledger"
    );
    assert!(dest.start_ledger < newer_start);
}

/// The reverse direction also preserves the earliest start: a newer source
/// moved into an older destination leaves the older start in place.
#[test]
fn consolidation_never_resets_to_a_later_lockup() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(
        admin,
        token_address.clone(),
        lending_pool,
        300,
    ));

    let older_goal = Symbol::new(&env, "older");
    let newer_goal = Symbol::new(&env, "newer");

    client.deposit(&borrower, &older_goal, &500);
    let older_start = read_record(&env, &client, &borrower, &older_goal).start_ledger;

    env.ledger().with_mut(|li| {
        li.sequence_number += 250;
    });
    client.deposit(&borrower, &newer_goal, &500);

    // Newer source into older destination.
    client.transfer_between_goals(&borrower, &newer_goal, &older_goal, &500);

    let dest = read_record(&env, &client, &borrower, &older_goal);
    assert_eq!(dest.start_ledger, older_start);
}

/// Cross-borrower transfers are rejected: a goal held by another borrower has
/// no record under the caller and can be neither a source nor a destination.
#[test]
fn cross_borrower_transfer_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower_a, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), lending_pool, 0));

    let borrower_b = Address::generate(&env);
    StellarAssetClient::new(&env, &token_address).mint(&borrower_b, &10_000i128);

    let goal_a = Symbol::new(&env, "alice");
    let goal_b = Symbol::new(&env, "bob");
    client.deposit(&borrower_a, &goal_a, &700);
    client.deposit(&borrower_b, &goal_b, &500);

    // Bob cannot drain Alice's goal.
    assert!(
        client
            .try_transfer_between_goals(&borrower_b, &goal_a, &goal_b, &700)
            .is_err(),
        "borrower must not move another borrower's goal balance"
    );

    // Alice cannot redirect her balance into Bob's goal.
    assert!(
        client
            .try_transfer_between_goals(&borrower_a, &goal_a, &goal_b, &700)
            .is_err(),
        "borrower must not move funds into another borrower's goal"
    );

    // Balances are untouched by the rejected attempts.
    assert_eq!(client.get_borrower_balance(&borrower_a, &goal_a), 700);
    assert_eq!(client.get_borrower_balance(&borrower_b, &goal_b), 500);
}

/// Rejects nonsensical transfers: non-positive amounts and self-transfers.
#[test]
fn invalid_transfers_are_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), lending_pool, 0));

    let goal = Symbol::new(&env, "goal");
    let other = Symbol::new(&env, "other");
    client.deposit(&borrower, &goal, &500);
    client.deposit(&borrower, &other, &100);

    assert!(client
        .try_transfer_between_goals(&borrower, &goal, &other, &0)
        .is_err());
    assert!(client
        .try_transfer_between_goals(&borrower, &goal, &other, &-1)
        .is_err());
    assert!(client
        .try_transfer_between_goals(&borrower, &goal, &goal, &100)
        .is_err());
    assert!(client
        .try_transfer_between_goals(&borrower, &goal, &other, &501)
        .is_err());
}
