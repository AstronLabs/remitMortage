// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for the dynamic TTL bump configuration.
//!
//! The escrow no longer hardcodes instance/persistent TTL parameters: they are
//! supplied in `EscrowConfig` at initialization so Testnet and Pubnet
//! deployments can be tuned independently.

#![cfg(test)]

use crate::errors::EscrowError;
use crate::types::{DataKey, EscrowConfig, TtlKeeperEntry};
use crate::{EscrowContract, EscrowContractClient, MAX_TTL_KEEPER_BATCH};
use soroban_sdk::{
    testutils::{
        storage::{Instance, Persistent},
        Address as _, Ledger as _,
    },
    token::StellarAssetClient,
    Address, Env, Symbol, Vec,
};

/// Testnet-style TTL profile: short bumps, cheap to maintain.
const TESTNET_INSTANCE_BUMP: u32 = 100_000;
const TESTNET_INSTANCE_THRESHOLD: u32 = 25_000;
const TESTNET_PERSISTENT_BUMP: u32 = 120_000;
const TESTNET_PERSISTENT_THRESHOLD: u32 = 30_000;

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
        instance_bump_amount: TESTNET_INSTANCE_BUMP,
        instance_lifetime_threshold: TESTNET_INSTANCE_THRESHOLD,
        persistent_bump_amount: TESTNET_PERSISTENT_BUMP,
        persistent_lifetime_threshold: TESTNET_PERSISTENT_THRESHOLD,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    }
}

/// Registers an escrow contract without initializing it, plus a funded
/// borrower and a test USDC token.
fn setup(env: &Env) -> (EscrowContractClient<'_>, Address, Address, Address, Address) {
    // The host caps TTL extensions at max_entry_ttl, so raise it above every
    // bump amount used here.
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

#[test]
fn test_initialize_stores_custom_ttl_values() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token, lending_pool));

    env.as_contract(&client.address, || {
        let stored: EscrowConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        assert_eq!(stored.instance_bump_amount, TESTNET_INSTANCE_BUMP);
        assert_eq!(
            stored.instance_lifetime_threshold,
            TESTNET_INSTANCE_THRESHOLD
        );
        assert_eq!(stored.persistent_bump_amount, TESTNET_PERSISTENT_BUMP);
        assert_eq!(
            stored.persistent_lifetime_threshold,
            TESTNET_PERSISTENT_THRESHOLD
        );
    });
}

#[test]
fn test_initialize_accepts_pubnet_scale_ttl_values() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _borrower, token, lending_pool) = setup(&env);
    let mut config = base_config(admin, token, lending_pool);
    config.instance_bump_amount = 518_400u32;
    config.instance_lifetime_threshold = 129_600u32;
    config.persistent_bump_amount = 900_000u32;
    config.persistent_lifetime_threshold = 300_000u32;

    client.initialize(&config);

    env.as_contract(&client.address, || {
        let stored: EscrowConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        assert_eq!(stored.instance_bump_amount, 518_400u32);
        assert_eq!(stored.persistent_bump_amount, 900_000u32);
    });
}

#[test]
fn test_initialize_rejects_zero_ttl_values() {
    let zeroing: [fn(&mut EscrowConfig); 4] = [
        |c| c.instance_bump_amount = 0,
        |c| c.instance_lifetime_threshold = 0,
        |c| c.persistent_bump_amount = 0,
        |c| c.persistent_lifetime_threshold = 0,
    ];

    for apply in zeroing {
        let env = Env::default();
        env.mock_all_auths();

        let (client, admin, _borrower, token, lending_pool) = setup(&env);
        let mut config = base_config(admin, token, lending_pool);
        apply(&mut config);

        let result = client.try_initialize(&config);
        assert_eq!(result.unwrap_err(), Ok(EscrowError::InvalidTtlConfig));
    }
}

#[test]
fn test_initialize_rejects_bump_below_threshold() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _borrower, token, lending_pool) = setup(&env);
    let mut config = base_config(admin, token, lending_pool);
    config.instance_bump_amount = 1_000u32;
    config.instance_lifetime_threshold = 5_000u32;

    let result = client.try_initialize(&config);
    assert_eq!(result.unwrap_err(), Ok(EscrowError::InvalidTtlConfig));
}

#[test]
fn test_instance_ttl_uses_configured_bump() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token, lending_pool));

    env.as_contract(&client.address, || {
        assert!(
            env.storage().instance().get_ttl() >= TESTNET_INSTANCE_BUMP,
            "instance TTL must be bumped to at least the configured amount",
        );
    });
}

#[test]
fn test_persistent_ttl_uses_configured_bump_on_deposit() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token.clone(), lending_pool));

    let goal_id = Symbol::new(&env, "land");
    client.deposit(&borrower, &goal_id, &1_000_0000000i128);

    env.as_contract(&client.address, || {
        let key = DataKey::Borrower(borrower.clone(), goal_id.clone());
        assert!(
            env.storage().persistent().get_ttl(&key) >= TESTNET_PERSISTENT_BUMP,
            "borrower record TTL must be bumped to at least the configured amount",
        );
    });
}

#[test]
fn test_two_deployments_can_use_different_ttl_profiles() {
    let env = Env::default();
    env.mock_all_auths();

    let (testnet_client, admin, _borrower, token, lending_pool) = setup(&env);
    testnet_client.initialize(&base_config(
        admin.clone(),
        token.clone(),
        lending_pool.clone(),
    ));

    let pubnet_id = env.register(EscrowContract, ());
    let pubnet_client = EscrowContractClient::new(&env, &pubnet_id);
    let mut pubnet_config = base_config(admin, token, lending_pool);
    pubnet_config.instance_bump_amount = 518_400u32;
    pubnet_config.instance_lifetime_threshold = 129_600u32;
    pubnet_client.initialize(&pubnet_config);

    env.as_contract(&testnet_client.address, || {
        let stored: EscrowConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        assert_eq!(stored.instance_bump_amount, TESTNET_INSTANCE_BUMP);
    });
    env.as_contract(&pubnet_id, || {
        let stored: EscrowConfig = env.storage().instance().get(&DataKey::Config).unwrap();
        assert_eq!(stored.instance_bump_amount, 518_400u32);
    });
}

#[test]
fn first_deposit_receives_match_within_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, borrower, token, lending_pool) = setup(&env);
    let mut config = base_config(admin, token, lending_pool);
    config.match_bps = 1_000;
    config.match_cap = 100;
    client.initialize(&config);

    let goal = Symbol::new(&env, "match");
    client.deposit(&borrower, &goal, &500);
    assert_eq!(client.get_borrower_balance(&borrower, &goal), 550);
}

#[test]
fn exhausted_matching_reserve_does_not_revert_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, admin, borrower, token, lending_pool) = setup(&env);
    let mut config = base_config(admin, token, lending_pool);
    config.match_bps = 1_000;
    config.match_cap = 100;
    client.initialize(&config);
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .set(&DataKey::MatchingReserve, &0i128);
    });

    let goal = Symbol::new(&env, "empty");
    client.deposit(&borrower, &goal, &500);
    assert_eq!(client.get_borrower_balance(&borrower, &goal), 500);
}

// ── Issue #855: permissionless TTL keeper ───────────────────────────────

/// An arbitrary keeper extends both the instance TTL and the listed borrower
/// record once their remaining TTL has fallen below the configured threshold.
#[test]
fn extend_ttl_batch_restores_instance_and_record_ttls() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token, lending_pool));

    let goal = Symbol::new(&env, "land");
    client.deposit(&borrower, &goal, &10_000_000_000_i128);

    // Move into the bump window: remaining persistent TTL drops just below
    // TESTNET_PERSISTENT_THRESHOLD, and instance TTL below its threshold too.
    let advance = TESTNET_PERSISTENT_BUMP - TESTNET_PERSISTENT_THRESHOLD + 1;
    env.ledger().set_sequence_number(advance);

    let key = DataKey::Borrower(borrower.clone(), goal.clone());
    env.as_contract(&client.address, || {
        assert!(
            env.storage().persistent().get_ttl(&key) < TESTNET_PERSISTENT_THRESHOLD,
            "precondition: record TTL is inside the bump window",
        );
    });

    let mut entries = Vec::new(&env);
    entries.push_back(TtlKeeperEntry {
        borrower: borrower.clone(),
        goal_id: goal.clone(),
    });

    // No auth is required: any keeper may call this.
    let extended = client.extend_ttl_batch(&entries);
    assert_eq!(extended, 1);

    env.as_contract(&client.address, || {
        assert!(
            env.storage().persistent().get_ttl(&key) >= TESTNET_PERSISTENT_BUMP,
            "record TTL must be restored to the configured bump",
        );
        assert!(
            env.storage().instance().get_ttl() >= TESTNET_INSTANCE_BUMP,
            "instance TTL must be restored to the configured bump",
        );
    });
}

#[test]
fn extend_ttl_batch_rejects_an_empty_batch() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token, lending_pool));

    let entries: Vec<TtlKeeperEntry> = Vec::new(&env);
    let result = client.try_extend_ttl_batch(&entries);
    assert_eq!(result, Err(Ok(EscrowError::InvalidTtlConfig)));
}

#[test]
fn extend_ttl_batch_rejects_an_oversized_batch() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token, lending_pool));

    let mut entries = Vec::new(&env);
    for _ in 0..=MAX_TTL_KEEPER_BATCH {
        entries.push_back(TtlKeeperEntry {
            borrower: borrower.clone(),
            goal_id: Symbol::new(&env, "land"),
        });
    }

    let result = client.try_extend_ttl_batch(&entries);
    assert_eq!(result, Err(Ok(EscrowError::InvalidTtlConfig)));
}

/// Only records the contract actually owns can be named: an entry that was
/// never initialized is rejected instead of extending an arbitrary key.
#[test]
fn extend_ttl_batch_rejects_unknown_records() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _borrower, token, lending_pool) = setup(&env);
    client.initialize(&base_config(admin, token, lending_pool));

    let mut entries = Vec::new(&env);
    entries.push_back(TtlKeeperEntry {
        borrower: Address::generate(&env),
        goal_id: Symbol::new(&env, "ghost"),
    });

    let result = client.try_extend_ttl_batch(&entries);
    assert_eq!(result, Err(Ok(EscrowError::EscrowGoalNotFound)));
}
