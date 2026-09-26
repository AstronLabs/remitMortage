// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Issue #472: contract storage migration regression tests.
//!
//! Verifies that contract storage survives sequential schema-version
//! transitions and the post-upgrade `migrate()` hook unchanged, and that a
//! malformed migration attempt fails without corrupting existing state.
//!
//! Note on scope: a real WASM swap cannot be driven under the test host
//! because (a) the host rejects metadata-less modules and (b) the workspace's
//! `wasm32` build currently fails with duplicate-symbol link errors (a
//! pre-existing repo issue). These tests therefore assert the storage
//! preservation guarantee directly: version transitions and the migration
//! hook must never disturb existing values, and a failed upgrade must not
//! half-apply.

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    BytesN, Env,
};

/// mark_default calls <escrow>.seize_collateral(...) for real (see the
/// crate-dependency note above `premium_for` in lib.rs), so any pool needs a
/// real registered contract at the escrow address, not a bare generated
/// Address.
#[contract]
pub struct ZeroSeizureEscrow;

#[contractimpl]
impl ZeroSeizureEscrow {
    pub fn seize_collateral(_env: Env, _borrower: Address, _lending_pool_address: Address) -> i128 {
        0
    }
}

fn setup_pool(
    env: &Env,
) -> (
    Address,
    Address,
    Address,
    Address,
    LendingPoolContractClient<'_>,
) {
    let admin = Address::generate(env);
    let investor = Address::generate(env);
    let treasury = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();
    let sac = StellarAssetClient::new(env, &token_address);
    sac.mint(&investor, &100_000_0000000i128);
    let escrow = env.register(ZeroSeizureEscrow, ());
    let contract_id = env.register(LendingPoolContract, ());
    let client = LendingPoolContractClient::new(env, &contract_id);
    client.initialize(
        &admin,
        &token_address,
        &escrow,
        &800u32,
        &400u32,
        &treasury,
        &0u32,
        &0u32,
    );
    (admin, investor, treasury, token_address, client)
}

fn mock_loan_id(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[7u8; 32])
}

fn populate_storage(
    env: &Env,
    client: &LendingPoolContractClient<'_>,
    investor: &Address,
) -> (Address, BytesN<32>) {
    let borrower = Address::generate(env);
    let loan_id = mock_loan_id(env);
    client.deposit(investor, &50_000_0000000i128, &Tranche::Senior);
    client.request_loan(&borrower, &loan_id, &20_000_0000000i128);
    client.approve_loan(&loan_id);
    (borrower, loan_id)
}

fn assert_storage_intact(
    client: &LendingPoolContractClient<'_>,
    investor: &Address,
    loan_id: &BytesN<32>,
    config_before: &PoolConfig,
    investor_before: &InvestorRecord,
    loan_before: &LoanRecord,
    liquidity_before: i128,
) {
    assert_eq!(client.get_pool_config(), *config_before);
    assert_eq!(client.get_investor_info(investor), *investor_before);
    assert_eq!(client.get_loan_info(loan_id), *loan_before);
    assert_eq!(client.get_liquidity(), liquidity_before);
}

fn advance_version(env: &Env, client: &LendingPoolContractClient<'_>, to: u32) {
    env.as_contract(&client.address, || {
        env.storage().instance().set(&DataKey::Version, &to);
    });
}

#[test]
fn sequential_version_transitions_preserve_storage() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
    let (_borrower, loan_id) = populate_storage(&env, &client, &investor);
    let config_before = client.get_pool_config();
    let investor_before = client.get_investor_info(&investor);
    let loan_before = client.get_loan_info(&loan_id);
    let liquidity_before = client.get_liquidity();
    assert_eq!(client.version(), 1u32);
    advance_version(&env, &client, 2u32);
    client.migrate();
    assert_eq!(client.version(), 2u32);
    assert_storage_intact(
        &client,
        &investor,
        &loan_id,
        &config_before,
        &investor_before,
        &loan_before,
        liquidity_before,
    );
    advance_version(&env, &client, 3u32);
    client.migrate();
    assert_eq!(client.version(), 3u32);
    assert_storage_intact(
        &client,
        &investor,
        &loan_id,
        &config_before,
        &investor_before,
        &loan_before,
        liquidity_before,
    );
}

#[test]
fn malformed_migration_fails_without_corrupting_state() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
    let (_borrower, loan_id) = populate_storage(&env, &client, &investor);
    let config_before = client.get_pool_config();
    let investor_before = client.get_investor_info(&investor);
    let loan_before = client.get_loan_info(&loan_id);
    let liquidity_before = client.get_liquidity();
    assert_eq!(client.version(), 1u32);
    let bogus = BytesN::from_array(&env, &[9u8; 32]);
    assert!(client.try_upgrade(&bogus).is_err());
    assert_eq!(client.version(), 1u32);
    assert_storage_intact(
        &client,
        &investor,
        &loan_id,
        &config_before,
        &investor_before,
        &loan_before,
        liquidity_before,
    );
}
