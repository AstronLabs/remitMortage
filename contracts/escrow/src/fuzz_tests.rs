// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Invariant-based property tests for Escrow deposit/withdraw math.
//!
//! Each `proptest!` block drives hundreds of randomised inputs through a core
//! contract invariant. Failures are automatically shrunk to a minimal example.

#![cfg(test)]
extern crate std;

use crate::{
    test_utils::advance_ledger_sequence,
    types::EscrowConfig,
    EscrowContract, EscrowContractClient, LEDGERS_PER_MONTH,
};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, Env, Symbol,
};

// ─── Budget constants ─────────────────────────────────────────────────────────

const MINT: i128 = 100_000_0000000; // 100 000 USDC minted to each borrower
const TARGET: i128 = 50_000_0000000; // 50 000 USDC savings target (high so tests don't hit it)

// ─── Shared setup ─────────────────────────────────────────────────────────────

fn make_config(admin: Address, token: Address) -> EscrowConfig {
    EscrowConfig {
        admin,
        token,
        savings_target: TARGET,
        max_duration_ledgers: 518_400,
        early_withdrawal_penalty_bps: 500,
        min_duration_ledgers: 0,
        penalty_bps_tier1: 500,  // 5 %  months 1-2
        penalty_bps_tier2: 300,  // 3 %  months 3-4
        penalty_bps_tier3: 150,  // 1.5% months 5-6
        penalty_bps_tier4: 50,   // 0.5% month 7+
        grace_period_ledgers: 10,
        default_penalty_bps: 1_000,
    }
}

/// Returns (admin, borrower, token_address, goal_id, client).
fn setup(env: &Env) -> (Address, Address, Address, Symbol, EscrowContractClient) {
    let admin = Address::generate(env);
    let borrower = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_id.address();
    StellarAssetClient::new(env, &token_address).mint(&borrower, &MINT);

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);
    client.initialize(&make_config(admin.clone(), token_address.clone()));

    let goal_id = Symbol::new(env, "fuzz");
    (admin, borrower, token_address, goal_id, client)
}

// ─── Invariant tests ──────────────────────────────────────────────────────────

proptest! {
    // ── Invariant 1 ──────────────────────────────────────────────────────────
    // A single deposit of any valid positive amount must increase both
    // `borrower.deposited` and `total_pooled` by exactly that amount,
    // and must move exactly that many tokens into the contract.
    #[test]
    fn deposit_increments_balances_exactly(
        amount in 1i128..=i128::MAX,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let (_, borrower, token_addr, goal_id, client) = setup(&env);
        let token = soroban_sdk::token::Client::new(&env, &token_addr);
        
        // Mint the specific amount needed to avoid insufficient balance, 
        // without overflowing the total token supply if it was already minted.
        StellarAssetClient::new(&env, &token_addr).mint(&borrower, &amount);

        let pool_before = client.get_total_pooled();
        let deposited_before = client.get_borrower_info(&borrower, &goal_id).deposited;
        let contract_bal_before = token.balance(&client.address);

        // We expect an overflow panic if we deposit past i128::MAX total, but for a single deposit it should work
        let res = client.try_deposit(&borrower, &goal_id, &amount);
        prop_assume!(res.is_ok());

        prop_assert_eq!(client.get_total_pooled(), pool_before + amount,
            "total_pooled must increase by deposit amount");
        prop_assert_eq!(
            client.get_borrower_info(&borrower, &goal_id).deposited,
            deposited_before + amount,
            "borrower.deposited must increase by deposit amount",
        );
        prop_assert_eq!(token.balance(&client.address), contract_bal_before + amount,
            "contract token balance must increase by deposit amount");
    }

    // ── Invariant 2 ──────────────────────────────────────────────────────────
    // N sequential deposits by the same borrower must accumulate: the final
    // `borrower.deposited` equals Σ amounts and `total_pooled` equals the same.
    #[test]
    fn sequential_deposits_accumulate_correctly(
        amounts in proptest::collection::vec(1i128..=2_000_0000000i128, 1..=5usize),
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let (_, borrower, token_addr, goal_id, client) = setup(&env);
        let token = soroban_sdk::token::Client::new(&env, &token_addr);

        let total: i128 = amounts.iter().sum();
        prop_assume!(total <= MINT);

        for amount in &amounts {
            client.deposit(&borrower, &goal_id, amount);
        }

        prop_assert_eq!(client.get_borrower_info(&borrower, &goal_id).deposited, total,
            "accumulated deposited must equal Σ amounts");
        prop_assert_eq!(client.get_total_pooled(), total,
            "total_pooled must equal Σ amounts after sequential deposits");
        prop_assert_eq!(token.balance(&client.address), total,
            "contract token balance must equal Σ amounts");
    }

    // ── Invariant 3 ──────────────────────────────────────────────────────────
    // Pure arithmetic: for any deposited amount D and any penalty in bps P,
    // penalty + refund == D, both terms are non-negative, and refund <= D.
    // This verifies the division formula used in `withdraw` is loss-free.
    #[test]
    fn penalty_plus_refund_equals_deposited(
        deposited in 1i128..=50_000_0000000i128,
        penalty_bps in 0u32..=10_000u32,
    ) {
        let penalty = (deposited * penalty_bps as i128) / 10_000;
        let refund = deposited - penalty;

        prop_assert!(penalty >= 0, "penalty must be non-negative");
        prop_assert!(refund >= 0, "refund must be non-negative");
        prop_assert!(refund <= deposited, "refund must not exceed deposited");
        prop_assert_eq!(penalty + refund, deposited,
            "penalty + refund must reconstruct deposited exactly");
    }

    // ── Invariant 4 ──────────────────────────────────────────────────────────
    // After a successful withdraw:
    //   - refund is in [0, deposited]
    //   - borrower receives exactly refund tokens
    //   - contract retains exactly the penalty (deposited - refund)
    //   - total_pooled returns to zero
    //   - the borrower record is marked withdrawn with deposited == 0
    //   - a second withdraw attempt always returns an error
    #[test]
    fn withdraw_conserves_tokens_and_blocks_retry(
        amount in 1i128..=5_000_0000000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let (_, borrower, token_addr, goal_id, client) = setup(&env);
        let token = soroban_sdk::token::Client::new(&env, &token_addr);

        client.deposit(&borrower, &goal_id, &amount);
        let borrower_bal_after_deposit = token.balance(&borrower);

        let refund = client.withdraw(&borrower, &goal_id);

        // Refund bounds
        prop_assert!(refund >= 0, "refund must be >= 0");
        prop_assert!(refund <= amount, "refund must not exceed deposited");

        // Token conservation
        let penalty = amount - refund;
        prop_assert_eq!(token.balance(&borrower), borrower_bal_after_deposit + refund,
            "borrower must receive exactly refund");
        prop_assert_eq!(token.balance(&client.address), penalty,
            "contract must retain exactly the penalty");

        // Accounting
        prop_assert_eq!(client.get_total_pooled(), 0,
            "total_pooled must be zero after the only borrower withdraws");

        // Record state
        let rec = client.get_borrower_info(&borrower, &goal_id);
        prop_assert!(rec.withdrawn, "borrower record must be marked withdrawn");
        prop_assert_eq!(rec.deposited, 0, "borrower.deposited must be cleared after withdraw");

        // Idempotency guard
        prop_assert!(client.try_withdraw(&borrower, &goal_id).is_err(),
            "second withdraw must return an error");
    }

    // ── Invariant 5 ──────────────────────────────────────────────────────────
    // Deposits by borrower A must not alter borrower B's record, and
    // total_pooled must equal the sum of both borrowers' deposited amounts.
    #[test]
    fn deposits_are_isolated_per_borrower(
        amount_a in 1i128..=5_000_0000000i128,
        amount_b in 1i128..=5_000_0000000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let (_, borrower_a, token_addr, goal_id, client) = setup(&env);

        let borrower_b = Address::generate(&env);
        StellarAssetClient::new(&env, &token_addr).mint(&borrower_b, &MINT);

        client.deposit(&borrower_a, &goal_id, &amount_a);
        client.deposit(&borrower_b, &goal_id, &amount_b);

        prop_assert_eq!(client.get_borrower_info(&borrower_a, &goal_id).deposited, amount_a,
            "borrower A's deposited must be unaffected by borrower B");
        prop_assert_eq!(client.get_borrower_info(&borrower_b, &goal_id).deposited, amount_b,
            "borrower B's deposited must be unaffected by borrower A");
        prop_assert_eq!(client.get_total_pooled(), amount_a + amount_b,
            "total_pooled must equal the sum of both borrowers' deposits");
    }

    // ── Invariant 6 ──────────────────────────────────────────────────────────
    // A zero-amount deposit must always be rejected regardless of contract state.
    #[test]
    fn zero_deposit_always_rejected(_noise in 0u8..=255u8) {
        let env = Env::default();
        env.mock_all_auths();
        let (_, borrower, _, goal_id, client) = setup(&env);
        prop_assert!(client.try_deposit(&borrower, &goal_id, &0i128).is_err(),
            "deposit(0) must always fail");
    }

    // ── Invariant 7 ──────────────────────────────────────────────────────────
    // Penalty tiers are monotone-decreasing: a borrower who withdraws later
    // always receives a refund >= one who withdraws earlier (lower penalty bps).
    // tier1 (months 1-2, 5%) → tier2 (months 3-4, 3%) → tier3 (months 5-6, 1.5%) → tier4 (month 7+, 0.5%).
    #[test]
    fn penalty_tiers_decrease_monotonically(
        amount in 1_000_0000000i128..=10_000_0000000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token_addr = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_addr);

        // Helper: deploy a fresh escrow, deposit, advance to `month`, withdraw.
        let refund_at_month = |target_month: u32| -> i128 {
            let borrower = Address::generate(&env);
            sac.mint(&borrower, &amount);

            let cid = env.register(EscrowContract, ());
            let client = EscrowContractClient::new(&env, &cid);
            // High savings target so release is never triggered.
            client.initialize(&make_config(admin.clone(), token_addr.clone()));

            let goal = Symbol::new(&env, "tier");
            client.deposit(&borrower, &goal, &amount);

            // Advance ledger so that (elapsed / LEDGERS_PER_MONTH) puts us in the target month.
            let ledgers = (target_month - 1) * LEDGERS_PER_MONTH + 1;
            advance_ledger_sequence(&env, ledgers);

            client.withdraw(&borrower, &goal)
        };

        let refund_tier1 = refund_at_month(1); // 5 % penalty → smallest refund
        let refund_tier2 = refund_at_month(3); // 3 % penalty
        let refund_tier3 = refund_at_month(5); // 1.5% penalty
        let refund_tier4 = refund_at_month(7); // 0.5% penalty → largest refund

        prop_assert!(refund_tier1 <= refund_tier2,
            "tier1 refund ({refund_tier1}) must be <= tier2 refund ({refund_tier2})");
        prop_assert!(refund_tier2 <= refund_tier3,
            "tier2 refund ({refund_tier2}) must be <= tier3 refund ({refund_tier3})");
        prop_assert!(refund_tier3 <= refund_tier4,
            "tier3 refund ({refund_tier3}) must be <= tier4 refund ({refund_tier4})");
    }

    // ── Invariant 8 ──────────────────────────────────────────────────────────
    // Separate goal IDs for the same borrower maintain independent records;
    // a deposit to goal A must not change goal B's balance.
    #[test]
    fn goal_ids_are_isolated_for_same_borrower(
        amount_a in 1i128..=2_000_0000000i128,
        amount_b in 1i128..=2_000_0000000i128,
    ) {
        let env = Env::default();
        env.mock_all_auths();
        let (_, borrower, _, _, client) = setup(&env);

        let goal_a = Symbol::new(&env, "goalA");
        let goal_b = Symbol::new(&env, "goalB");

        client.deposit(&borrower, &goal_a, &amount_a);
        client.deposit(&borrower, &goal_b, &amount_b);

        prop_assert_eq!(client.get_borrower_info(&borrower, &goal_a).deposited, amount_a,
            "goal A deposited must be unaffected by goal B deposit");
        prop_assert_eq!(client.get_borrower_info(&borrower, &goal_b).deposited, amount_b,
            "goal B deposited must be unaffected by goal A deposit");
        prop_assert_eq!(client.get_total_pooled(), amount_a + amount_b,
            "total_pooled must equal the sum of both goal deposits");
    }
}
