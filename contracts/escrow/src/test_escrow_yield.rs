// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Unit tests for escrow holding-yield distribution (#1022).
//!
//! When an escrow is backed by an admin-configured yield source, any yield the
//! escrowed balance earns while it is held must be credited to that escrow's
//! own borrower — never pooled, and never handed to the release recipient. An
//! escrow with no yield source must behave exactly as it did before.

#![cfg(test)]

use crate::test_utils::{MockYieldVault, MockYieldVaultClient};
use crate::types::{DataKey, EscrowConfig};
use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

fn base_config(
    env: &Env,
    admin: Address,
    token: Address,
    yield_vault: Option<Address>,
    savings_target: i128,
) -> EscrowConfig {
    EscrowConfig {
        admin,
        token,
        lending_pool: Address::generate(env),
        savings_target,
        max_duration_ledgers: 518_400u32,
        early_withdrawal_penalty_bps: 0u32,
        min_duration_ledgers: 0u32,
        penalty_bps_tier1: 0u32,
        penalty_bps_tier2: 0u32,
        penalty_bps_tier3: 0u32,
        penalty_bps_tier4: 0u32,
        grace_period_ledgers: 10u32,
        default_penalty_bps: 0u32,
        instance_bump_amount: 518_400u32,
        instance_lifetime_threshold: 129_600u32,
        persistent_bump_amount: 518_400u32,
        persistent_lifetime_threshold: 129_600u32,
        yield_vault,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    }
}

struct Harness<'a> {
    client: EscrowContractClient<'a>,
    borrower: Address,
    token_client: TokenClient<'a>,
}

fn setup<'a>(env: &'a Env, with_yield: bool, savings_target: i128) -> Harness<'a> {
    // The mock vault mints simulated yield via the token admin (a non-root auth).
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 3_000_000;
        li.max_entry_ttl = 10_000_000;
    });

    let admin = Address::generate(env);
    let borrower = Address::generate(env);

    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_id.address();
    StellarAssetClient::new(env, &token).mint(&borrower, &1_000_000i128);
    let token_client = TokenClient::new(env, &token);

    let yield_vault = if with_yield {
        let vault_id = env.register(MockYieldVault, ());
        MockYieldVaultClient::new(env, &vault_id).init(&token);
        Some(vault_id)
    } else {
        None
    };

    let escrow_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &escrow_id);
    client.initialize(&base_config(env, admin, token, yield_vault, savings_target));

    Harness {
        client,
        borrower,
        token_client,
    }
}

fn yield_shares(
    env: &Env,
    client: &EscrowContractClient<'_>,
    borrower: &Address,
    goal: &Symbol,
) -> i128 {
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .get(&DataKey::YieldShares(borrower.clone(), goal.clone()))
            .unwrap_or(0)
    })
}

fn total_yield_shares(env: &Env, client: &EscrowContractClient<'_>) -> i128 {
    env.as_contract(&client.address, || {
        env.storage()
            .instance()
            .get(&DataKey::TotalYieldShares)
            .unwrap_or(0)
    })
}

/// A yield-enabled escrow credits the yield earned while funds were held to the
/// escrow's own borrower, while the recipient receives only the principal.
#[test]
fn yield_enabled_release_credits_the_escrows_borrower() {
    let env = Env::default();
    let h = setup(&env, true, 1_000);

    let goal = Symbol::new(&env, "downpayment");
    h.client.deposit(&h.borrower, &goal, &1_000);

    // Deposits were routed into the vault and recorded as this goal's shares.
    assert_eq!(h.token_client.balance(&h.client.address), 0);
    assert_eq!(yield_shares(&env, &h.client, &h.borrower, &goal), 1_000);
    assert_eq!(total_yield_shares(&env, &h.client), 1_000);

    let recipient = Address::generate(&env);
    let borrower_before = h.token_client.balance(&h.borrower);

    let released = h.client.release(&h.borrower, &goal, &recipient);

    // Principal plus the 10% holding yield is withdrawn from the vault.
    assert_eq!(released, 1_100);

    // The recipient is paid the principal only...
    assert_eq!(h.token_client.balance(&recipient), 1_000);
    // ...and the holding yield is credited to the escrow's own borrower.
    assert_eq!(h.token_client.balance(&h.borrower) - borrower_before, 100);

    // Nothing is left stranded in the vault or the escrow.
    assert_eq!(total_yield_shares(&env, &h.client), 0);
    assert_eq!(h.token_client.balance(&h.client.address), 0);
}

/// An escrow with the yield source disabled behaves exactly as it does today:
/// the full balance is released to the recipient and no yield is credited.
#[test]
fn yield_disabled_release_is_unchanged() {
    let env = Env::default();
    let h = setup(&env, false, 1_000);

    let goal = Symbol::new(&env, "downpayment");
    h.client.deposit(&h.borrower, &goal, &1_000);

    let recipient = Address::generate(&env);
    let borrower_before = h.token_client.balance(&h.borrower);

    let released = h.client.release(&h.borrower, &goal, &recipient);

    assert_eq!(released, 1_000);
    assert_eq!(h.token_client.balance(&recipient), 1_000);
    assert_eq!(h.token_client.balance(&h.borrower), borrower_before);
    assert_eq!(h.token_client.balance(&h.client.address), 0);
}

/// A partial disbursement (moving part of one goal's balance to another goal)
/// carries the backing yield shares pro-rata, so the yield credited on release
/// matches the amount actually held in that escrow.
#[test]
fn yield_enabled_partial_transfer_carries_yield_pro_rata() {
    let env = Env::default();
    let h = setup(&env, true, 600);

    let from_goal = Symbol::new(&env, "primary");
    let to_goal = Symbol::new(&env, "secondary");

    h.client.deposit(&h.borrower, &from_goal, &1_000);
    h.client.deposit(&h.borrower, &to_goal, &100);

    // Move 400 of the primary goal's 1,000 into the secondary goal; the 400 of
    // backing yield shares must travel with it.
    h.client
        .transfer_between_goals(&h.borrower, &from_goal, &to_goal, &400);

    assert_eq!(yield_shares(&env, &h.client, &h.borrower, &from_goal), 600);
    assert_eq!(yield_shares(&env, &h.client, &h.borrower, &to_goal), 500);
    // Reallocating between one borrower's own goals leaves the total unchanged.
    assert_eq!(total_yield_shares(&env, &h.client), 1_100);

    // Releasing the partially-disbursed goal credits only its own share of the
    // yield (10% of the remaining 600) to the borrower.
    let recipient = Address::generate(&env);
    let borrower_before = h.token_client.balance(&h.borrower);

    let released = h.client.release(&h.borrower, &from_goal, &recipient);

    assert_eq!(released, 660);
    assert_eq!(h.token_client.balance(&recipient), 600);
    assert_eq!(h.token_client.balance(&h.borrower) - borrower_before, 60);

    // The untouched secondary goal keeps its own yield claim.
    assert_eq!(yield_shares(&env, &h.client, &h.borrower, &from_goal), 0);
    assert_eq!(yield_shares(&env, &h.client, &h.borrower, &to_goal), 500);
    assert_eq!(total_yield_shares(&env, &h.client), 500);
}
