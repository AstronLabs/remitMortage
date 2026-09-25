// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for Escrow Auto-Rollover at maturity (#495).

#![cfg(test)]

use crate::types::{DataKey, EscrowConfig};
use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

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

#[test]
fn test_default_opt_out_releases_funds_normally() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, recipient) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), recipient.clone()));

    let goal_id = Symbol::new(&env, "house");
    let target_amount = 10_000_0000000i128;

    // Deposit full savings target
    client.deposit(&borrower, &goal_id, &target_amount);

    // Release at maturity (auto_rollover defaults to false)
    let released_amount = client.release(&borrower, &goal_id, &recipient);
    assert_eq!(released_amount, target_amount);

    // Recipient received full funds
    let token = TokenClient::new(&env, &token_address);
    assert_eq!(token.balance(&recipient), target_amount);

    // Borrower record is marked released with 0 balance
    env.as_contract(&client.address, || {
        let key = DataKey::Borrower(borrower.clone(), goal_id.clone());
        let record: crate::types::BorrowerRecord = env.storage().persistent().get(&key).unwrap();
        assert!(record.released);
        assert_eq!(record.deposited, 0);
    });
}

#[test]
fn test_opted_in_auto_rollover_seeds_new_cycle() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, recipient) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), recipient.clone()));

    let goal_id = Symbol::new(&env, "house");
    let target_amount = 10_000_0000000i128;

    // Deposit full target
    client.deposit(&borrower, &goal_id, &target_amount);

    // Opt-in to auto rollover
    client.set_auto_rollover(&borrower, &goal_id, &true);

    // Trigger release at maturity
    let rolled_over_amount = client.release(&borrower, &goal_id, &recipient);
    assert_eq!(rolled_over_amount, target_amount);

    // Recipient received NOTHING (funds stayed in escrow for new cycle)
    let token = TokenClient::new(&env, &token_address);
    assert_eq!(token.balance(&recipient), 0);

    // Borrower record is NOT released, but has a new active cycle seeded with matured balance
    env.as_contract(&client.address, || {
        let key = DataKey::Borrower(borrower.clone(), goal_id.clone());
        let record: crate::types::BorrowerRecord = env.storage().persistent().get(&key).unwrap();
        assert!(!record.released);
        assert_eq!(record.deposited, target_amount);
        assert!(record.auto_rollover);
    });
}

#[test]
fn test_mid_cycle_opt_out_reverts_to_normal_release() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, borrower, token_address, recipient) = setup(&env);
    client.initialize(&base_config(admin, token_address.clone(), recipient.clone()));

    let goal_id = Symbol::new(&env, "house");
    let target_amount = 10_000_0000000i128;

    client.deposit(&borrower, &goal_id, &target_amount);

    // Initially opt in
    client.set_auto_rollover(&borrower, &goal_id, &true);

    // Mid-cycle opt out before maturity
    client.set_auto_rollover(&borrower, &goal_id, &false);

    // Release at maturity
    let released_amount = client.release(&borrower, &goal_id, &recipient);
    assert_eq!(released_amount, target_amount);

    // Recipient received funds due to opt-out
    let token = TokenClient::new(&env, &token_address);
    assert_eq!(token.balance(&recipient), target_amount);

    env.as_contract(&client.address, || {
        let key = DataKey::Borrower(borrower.clone(), goal_id.clone());
        let record: crate::types::BorrowerRecord = env.storage().persistent().get(&key).unwrap();
        assert!(record.released);
        assert_eq!(record.deposited, 0);
        assert!(!record.auto_rollover);
    });
}
