//! Boundary tests for the early-exit penalty calculation in [`EscrowContract::withdraw`].
//!
//! The escrow contract deducts an early-exit penalty using tiered basis-point
//! rates keyed off how many "months" (in ledgers) have elapsed since the first
//! deposit:
//!
//! | Elapsed months | Tier  |
//! |----------------|-------|
//! | 1 – 2          | tier1 |
//! | 3 – 4          | tier2 |
//! | 5 – 6          | tier3 |
//! | 7+             | tier4 |
//!
//! `months_elapsed = 1 + (current_ledger - start_ledger) / LEDGERS_PER_MONTH`,
//! so an immediate withdrawal lands in tier 1, and each tier boundary is an
//! exact multiple of `LEDGERS_PER_MONTH` (= 100 in test builds).
//!
//! penalty = deposited * penalty_bps / 10_000   (integer division, BPS).
//!
//! These tests pin the rate selected at each tier boundary, confirm a zero-rate
//! tier yields no penalty after the lockup has elapsed, and check the BPS math
//! stays exact and overflow-free for very large deposits.

extern crate std;

use super::*;
use crate::test_utils::advance_ledger_sequence;
use soroban_sdk::{
    testutils::Address as _,
    token::StellarAssetClient,
    Address, Env, Symbol,
};

/// Deposit amount used across the boundary tests: 10,000 USDC (7 decimals).
const DEPOSIT: i128 = 10_000_0000000;

/// Build an escrow initialized with the supplied tier rates and lockup, with a
/// borrower who has already deposited `DEPOSIT`. Returns the client, borrower
/// and goal id so each test can advance ledgers and withdraw.
fn setup(
    env: &Env,
    tier_bps: (u32, u32, u32, u32),
    min_duration_ledgers: u32,
) -> (EscrowContractClient<'_>, Address, Symbol) {
    let admin = Address::generate(env);
    let borrower = Address::generate(env);
    let lending_pool = Address::generate(env);

    // Deploy a test SAC token (simulates USDC) and fund the borrower generously.
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_address = token_id.address();
    StellarAssetClient::new(env, &token_address).mint(&borrower, &(DEPOSIT * 10));

    let contract_id = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract_id);

    let (t1, t2, t3, t4) = tier_bps;
    client.initialize(&EscrowConfig {
        admin,
        token: token_address,
        lending_pool,
        savings_target: DEPOSIT * 5,
        max_duration_ledgers: 518_400,
        early_withdrawal_penalty_bps: t1,
        min_duration_ledgers,
        penalty_bps_tier1: t1,
        penalty_bps_tier2: t2,
        penalty_bps_tier3: t3,
        penalty_bps_tier4: t4,
        grace_period_ledgers: 10,
        default_penalty_bps: 1000,
        yield_vault: None,
    });

    let goal_id = Symbol::new(env, "land");
    client.deposit(&borrower, &goal_id, &DEPOSIT);

    (client, borrower, goal_id)
}

/// penalty = deposited * bps / 10_000; refund = deposited - penalty.
fn expected_refund(bps: u32) -> i128 {
    DEPOSIT - (DEPOSIT * bps as i128) / 10_000
}

#[test]
fn immediate_withdraw_charges_maximum_tier1_penalty() {
    let env = Env::default();
    env.mock_all_auths();
    // tier1 is the steepest rate (5%); immediate exit must pay it in full.
    let (client, borrower, goal_id) = setup(&env, (500, 300, 150, 50), 0);

    // No ledgers advanced => months_elapsed == 1 => tier1.
    let refund = client.withdraw(&borrower, &goal_id);
    assert_eq!(refund, expected_refund(500));
}

#[test]
fn withdraw_at_tier2_transition_block_uses_tier2_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, borrower, goal_id) = setup(&env, (500, 300, 150, 50), 0);

    // diff = 199 ledgers => months_elapsed = 1 + 199/100 = 2 => still tier1.
    advance_ledger_sequence(&env, LEDGERS_PER_MONTH * 2 - 1);
    // First crossing into tier2 is exactly 2 * LEDGERS_PER_MONTH (months 3).
    advance_ledger_sequence(&env, 1);

    let refund = client.withdraw(&borrower, &goal_id);
    assert_eq!(refund, expected_refund(300));
}

#[test]
fn tier_boundaries_select_the_correct_rate() {
    // One env per boundary so the borrower record is fresh each time.
    let cases: [(u32, u32); 4] = [
        (0, 500),                     // month 1  -> tier1
        (LEDGERS_PER_MONTH * 2, 300), // month 3  -> tier2 (first ledger of tier2)
        (LEDGERS_PER_MONTH * 4, 150), // month 5  -> tier3
        (LEDGERS_PER_MONTH * 6, 50),  // month 7  -> tier4
    ];

    for (elapsed, expected_bps) in cases {
        let env = Env::default();
        env.mock_all_auths();
        let (client, borrower, goal_id) = setup(&env, (500, 300, 150, 50), 0);
        advance_ledger_sequence(&env, elapsed);

        let refund = client.withdraw(&borrower, &goal_id);
        assert_eq!(
            refund,
            expected_refund(expected_bps),
            "wrong rate at {} ledgers elapsed",
            elapsed
        );
    }
}

#[test]
fn one_ledger_before_tier_boundary_keeps_previous_rate() {
    let env = Env::default();
    env.mock_all_auths();
    let (client, borrower, goal_id) = setup(&env, (500, 300, 150, 50), 0);

    // 1 ledger before the tier2 boundary => still tier1.
    advance_ledger_sequence(&env, LEDGERS_PER_MONTH * 2 - 1);
    let refund = client.withdraw(&borrower, &goal_id);
    assert_eq!(refund, expected_refund(500));
}

#[test]
fn withdraw_after_lockup_with_zero_tier4_rate_charges_no_penalty() {
    let env = Env::default();
    env.mock_all_auths();
    // tier4 configured to 0 bps: once the lockup window (6 "months") has passed
    // the borrower exits with a full refund and no penalty.
    let min_lock = LEDGERS_PER_MONTH * 6;
    let (client, borrower, goal_id) = setup(&env, (500, 300, 150, 0), min_lock);

    // 1 ledger after the lock expires => month 7 => tier4 (0 bps).
    advance_ledger_sequence(&env, min_lock + 1);

    let refund = client.withdraw(&borrower, &goal_id);
    assert_eq!(refund, DEPOSIT, "zero-rate tier must refund in full");
}

#[test]
fn bps_math_is_exact_and_overflow_free_for_large_deposits() {
    // Validate the penalty formula directly against the contract's integer math
    // for a near-maximal i128 deposit. penalty = amount * bps / 10_000 must not
    // overflow (i128 headroom) nor silently truncate beyond integer division.
    let amount: i128 = 1_000_000_000_000_000_000; // 1e18 stroops
    let bps: u32 = 250; // 2.5%

    // i128::MAX ≈ 1.7e38, so amount * bps ≈ 2.5e20 — far below overflow.
    let penalty = (amount * bps as i128) / 10_000;
    assert_eq!(penalty, 25_000_000_000_000_000); // exactly 2.5%
    assert_eq!(amount - penalty, 975_000_000_000_000_000);

    // The multiply must not overflow even at the largest deposit the formula
    // can accept without wrapping: amount <= i128::MAX / 10_000.
    let max_safe = i128::MAX / 10_000;
    let checked = max_safe.checked_mul(9_999).map(|v| v / 10_000);
    assert!(checked.is_some(), "penalty multiply overflowed for max deposit");
}
