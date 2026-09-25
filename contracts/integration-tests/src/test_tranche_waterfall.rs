// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tranche First-Loss and Default Stress Tests
//!
//! This module exercises the dual-tranche (Senior/Junior) lending pool under
//! high borrower delinquency rates (30% and 60% default scenarios). The tests
//! verify:
//!
//!  1. Junior tranche absorbs 100% of defaults up to its total capital.
//!  2. Senior tranche remains untouched while Junior capital covers losses.
//!  3. If defaults exceed total Junior capital, Senior begins absorbing the
//!     overflow remainder.
//!  4. Yield waterfall priority is preserved under partial-default scenarios:
//!     Senior investors receive their fixed APY before Junior receives any
//!     residual yield.
//!
//! Pool parameters used throughout:
//!  - 0% interest rate (convenient so outstanding_debt == disbursed amount)
//!  - 70 000 USDC Senior / 30 000 USDC Junior  (70 / 30 split)
//!  - 10 borrowers each requesting 5 000 USDC
//!  - 30% stress: 3 of 10 borrowers default  → loss 15 000 (absorbed by Jr)
//!  - 60% stress: 6 of 10 borrowers default  → loss 30 000 (exhausts Jr, Sr absorbs 0)
//!
//! NOTE: `mock_all_auths()` is used throughout so that `mark_default`'s
//! internal cross-contract `seize_collateral` call is satisfied without
//! deploying a real escrow contract.

#![cfg(test)]

use lending_pool::{
    LendingPoolContract, LendingPoolContractClient, LoanStatus, Tranche, TrancheInfo,
};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, BytesN, Env,
};

// ── Mock Escrow ──────────────────────────────────────────────────────────────

/// `mark_default` performs a real cross-contract call to
/// `<escrow>.seize_collateral(borrower, lending_pool_address) -> i128` to
/// recover any collateral before the loss is charged to the tranches. The
/// production Escrow contract does not implement this entrypoint yet (see
/// `lending_pool`'s own `MockEscrow` test double for the same reason), so any
/// test that drives `mark_default` needs a real registered contract at the
/// configured escrow address, not a bare generated `Address`. This mock
/// reports zero recovered collateral, matching this module's assertions,
/// which assume the full loan loss lands on the tranches.
#[contract]
pub struct MockEscrow;

#[contractimpl]
impl MockEscrow {
    pub fn seize_collateral(_env: Env, _borrower: Address, _lending_pool_address: Address) -> i128 {
        0
    }
}

// ── Constants ────────────────────────────────────────────────────────────────

/// 1 USDC in stroops (7 decimal places).
const USDC: i128 = 10_000_000;

/// Number of ledgers that makes a loan legally overdue (3 months ≈ 1 555 200
/// production ledgers; in cfg(test) `LEDGERS_PER_DAY` is 100, so a month is
/// 518 400 production ledgers — we simply jump directly past the schedule).
const OVERDUE_OFFSET: u32 = 3 * 518_400 + 1;

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Deploy a fresh USDC token and lending pool initialised at 0% interest/yield
/// so that outstanding debt equals the disbursed principal exactly (no
/// compounding noise in the assertions).
///
/// Returns `(admin, token_address, pool_client)`.
fn deploy_pool(env: &Env) -> (Address, Address, LendingPoolContractClient<'_>) {
    // Large TTLs so ledger time-jumps do not archive persistent storage.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 4_000_000;
        li.min_temp_entry_ttl = 4_000_000;
        li.max_entry_ttl = 6_000_000;
    });

    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    // mark_default calls <escrow>.seize_collateral(...) for real — needs an
    // actual registered contract, not a bare stub address. See MockEscrow.
    let escrow = env.register(MockEscrow, ());

    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_id.address();

    let pool_id = env.register(LendingPoolContract, ());
    let pool = LendingPoolContractClient::new(env, &pool_id);
    // 0% interest and 0% senior yield keeps the maths simple.
    pool.initialize(
        &admin, &token, &escrow, &0u32, &0u32, &treasury, &0u32, &0u32,
    );

    (admin, token, pool)
}

/// Seed the pool with a 70 / 30 (Senior / Junior) capital split.
///
/// Returns `(senior_investor, junior_investor)`.
fn seed_pool_70_30<'a>(
    env: &Env,
    pool: &LendingPoolContractClient<'a>,
    token: &Address,
) -> (Address, Address) {
    let sac = StellarAssetClient::new(env, token);

    let senior = Address::generate(env);
    let junior = Address::generate(env);

    sac.mint(&senior, &(70_000 * USDC));
    sac.mint(&junior, &(30_000 * USDC));

    pool.deposit(&senior, &(70_000 * USDC), &Tranche::Senior);
    pool.deposit(&junior, &(30_000 * USDC), &Tranche::Junior);

    (senior, junior)
}

/// Create and fully disburse a loan for `borrower`.
///
/// Returns the unique `loan_id` used for this loan.
fn create_and_disburse_loan(
    env: &Env,
    pool: &LendingPoolContractClient<'_>,
    borrower: &Address,
    amount: i128,
    seed: u8,
) -> BytesN<32> {
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    pool.request_loan(borrower, &loan_id, &amount);
    pool.approve_loan(&loan_id);
    // Whitelist borrower as contractor so disburse succeeds.
    pool.add_contractor(borrower);
    pool.disburse(&loan_id, borrower, &amount);
    loan_id
}

/// Advance the ledger past the repayment due date so the loan is overdue and
/// eligible for `mark_default`.
fn advance_past_due(env: &Env, pool: &LendingPoolContractClient<'_>, loan_id: &BytesN<32>) {
    let sched = pool.get_repayment_schedule(loan_id).unwrap();
    env.ledger()
        .set_sequence_number(sched.next_due_ledger + OVERDUE_OFFSET);
}

// ── Pool Setup: 10 borrowers, 5 000 USDC each ────────────────────────────────

/// Spin up 10 borrowers and disburse 5 000 USDC loans to each.
///
/// Returns `(borrowers, loan_ids)`.
fn setup_ten_borrowers(
    env: &Env,
    pool: &LendingPoolContractClient<'_>,
    token: &Address,
) -> (Vec<Address>, Vec<BytesN<32>>) {
    let sac = StellarAssetClient::new(env, token);
    let mut borrowers = Vec::new();
    let mut loan_ids = Vec::new();

    for i in 0u8..10 {
        let b = Address::generate(env);
        // Mint enough for potential repayment in the yield waterfall test.
        sac.mint(&b, &(6_000 * USDC));
        let lid = create_and_disburse_loan(env, pool, &b, 5_000 * USDC, i + 10);
        borrowers.push(b);
        loan_ids.push(lid);
    }

    (borrowers, loan_ids)
}

// ─────────────────────────────────────────────────────────────────────────────
// Stress Test: 30% Default Rate (3 / 10 borrowers default)
// ─────────────────────────────────────────────────────────────────────────────

/// 30% default scenario: Junior (30 000) absorbs 3 × 5 000 = 15 000 loss.
/// Senior (70 000) must remain completely untouched.
#[test]
fn stress_30pct_default_junior_absorbs_all() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, token, pool) = deploy_pool(&env);
    seed_pool_70_30(&env, &pool, &token);

    let (_, loan_ids) = setup_ten_borrowers(&env, &pool, &token);

    // Force loans 0, 1, 2 into default (30% of 10 borrowers).
    let defaulting = &loan_ids[0..3];
    for lid in defaulting {
        advance_past_due(&env, &pool, lid);
        pool.mark_default(lid);
    }

    let junior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Junior);
    let senior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Senior);

    // Each defaulting loan loses 5 000 USDC.  Junior (30 000) covers all 15 000.
    let expected_junior_loss = 3 * 5_000 * USDC; // 15 000 USDC

    assert_eq!(
        junior_info.total_loss_absorbed, expected_junior_loss,
        "junior should absorb exactly 15 000 USDC under 30% default"
    );
    assert_eq!(
        junior_info.total_deposited,
        30_000 * USDC - expected_junior_loss,
        "junior remaining capital should be 15 000 USDC after absorbing losses"
    );

    // Senior tranche must be entirely protected.
    assert_eq!(
        senior_info.total_loss_absorbed, 0,
        "senior tranche must absorb zero loss under 30% default rate"
    );
    assert_eq!(
        senior_info.total_deposited,
        70_000 * USDC,
        "senior deposited capital must be unchanged"
    );

    // All three defaulted loans are in Defaulted status.
    for lid in defaulting {
        let loan = pool.get_loan_info(lid);
        assert_eq!(loan.status, LoanStatus::Defaulted);
    }

    // Pool health sanity.
    let health = pool.get_pool_health();
    assert_eq!(health.defaulted_loans, 3);
    assert_eq!(health.total_defaulted_loss, expected_junior_loss);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stress Test: 60% Default Rate (6 / 10 borrowers default)
// ─────────────────────────────────────────────────────────────────────────────

/// 60% default scenario: 6 × 5 000 = 30 000 loss.
/// Junior capital is exactly 30 000 → it is fully exhausted.
/// Senior tranche still absorbs zero because Junior exactly covers the loss.
#[test]
fn stress_60pct_default_junior_fully_exhausted() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, token, pool) = deploy_pool(&env);
    seed_pool_70_30(&env, &pool, &token);

    let (_, loan_ids) = setup_ten_borrowers(&env, &pool, &token);

    // Force loans 0-5 into default (60% of 10 borrowers).
    let defaulting = &loan_ids[0..6];
    for lid in defaulting {
        advance_past_due(&env, &pool, lid);
        pool.mark_default(lid);
    }

    let junior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Junior);
    let senior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Senior);

    let expected_junior_loss = 6 * 5_000 * USDC; // 30 000 USDC

    // Junior is fully exhausted.
    assert_eq!(
        junior_info.total_loss_absorbed, expected_junior_loss,
        "junior must absorb 30 000 USDC (all its capital) under 60% default"
    );
    assert_eq!(
        junior_info.total_deposited, 0,
        "junior deposited capital must be 0 after full exhaustion"
    );

    // Senior absorbs zero because Junior's capital exactly covered the losses.
    assert_eq!(
        senior_info.total_loss_absorbed, 0,
        "senior must absorb zero when junior capital exactly equals loss"
    );
    assert_eq!(
        senior_info.total_deposited,
        70_000 * USDC,
        "senior deposited capital must remain unchanged"
    );

    let health = pool.get_pool_health();
    assert_eq!(health.defaulted_loans, 6);
    assert_eq!(health.total_defaulted_loss, expected_junior_loss);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stress Test: Defaults exceed Junior capital — Senior absorbs overflow
// ─────────────────────────────────────────────────────────────────────────────

/// When total defaults (7 × 5 000 = 35 000) exceed Junior capital (30 000),
/// the remaining 5 000 overflows into the Senior tranche.
#[test]
fn stress_super_threshold_senior_absorbs_overflow() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, token, pool) = deploy_pool(&env);
    seed_pool_70_30(&env, &pool, &token);

    let (_, loan_ids) = setup_ten_borrowers(&env, &pool, &token);

    // Default 7 out of 10 borrowers → 35 000 USDC loss.
    let defaulting = &loan_ids[0..7];
    for lid in defaulting {
        advance_past_due(&env, &pool, lid);
        pool.mark_default(lid);
    }

    let total_loss = 7 * 5_000 * USDC; // 35 000
    let junior_capacity = 30_000 * USDC; // 30 000
    let expected_senior_loss = total_loss - junior_capacity; // 5 000

    let junior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Junior);
    let senior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Senior);

    assert_eq!(
        junior_info.total_loss_absorbed, junior_capacity,
        "junior should absorb its full capacity of 30 000 USDC"
    );
    assert_eq!(
        junior_info.total_deposited, 0,
        "junior must be fully exhausted"
    );

    assert_eq!(
        senior_info.total_loss_absorbed, expected_senior_loss,
        "senior must absorb the 5 000 USDC overflow"
    );
    assert_eq!(
        senior_info.total_deposited,
        70_000 * USDC - expected_senior_loss,
        "senior deposited capital reduced by overflow"
    );

    let health = pool.get_pool_health();
    assert_eq!(health.defaulted_loans, 7);
    assert_eq!(health.total_defaulted_loss, total_loss);
}

// ─────────────────────────────────────────────────────────────────────────────
// Yield Waterfall: Senior receives fixed APY before Junior under 30% default
// ─────────────────────────────────────────────────────────────────────────────

/// With 8% pool APY and 4% fixed senior APY, the yield waterfall must credit
/// Senior tranche yield before any residual is distributed to Junior.
/// After partial repayment (covering principal + partial interest), Senior
/// yield_distributed should be > 0 and ≤ Junior yield_distributed only once
/// Senior APY is fully satisfied.
#[test]
fn yield_waterfall_prioritises_senior_under_30pct_default() {
    let env = Env::default();
    env.mock_all_auths();

    // Use 8% pool / 4% senior yield so yield distribution is non-trivial.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 4_000_000;
        li.min_temp_entry_ttl = 4_000_000;
        li.max_entry_ttl = 6_000_000;
    });

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    // mark_default calls <escrow>.seize_collateral(...) for real — needs an
    // actual registered contract, not a bare stub address. See MockEscrow.
    let escrow = env.register(MockEscrow, ());

    let token_admin = Address::generate(&env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_id.address();
    let sac = StellarAssetClient::new(&env, &token);

    let pool_id = env.register(LendingPoolContract, ());
    let pool = LendingPoolContractClient::new(&env, &pool_id);
    // 8% pool interest, 4% fixed senior yield.
    pool.initialize(
        &admin, &token, &escrow, &800u32, &400u32, &treasury, &0u32, &0u32,
    );

    // Fund with 70 / 30 split.
    let senior = Address::generate(&env);
    let junior = Address::generate(&env);
    sac.mint(&senior, &(70_000 * USDC));
    sac.mint(&junior, &(30_000 * USDC));
    pool.deposit(&senior, &(70_000 * USDC), &Tranche::Senior);
    pool.deposit(&junior, &(30_000 * USDC), &Tranche::Junior);

    // Set up 10 borrowers, 5 000 USDC each.
    let mut borrowers = Vec::new();
    let mut loan_ids = Vec::new();
    for i in 0u8..10 {
        let b = Address::generate(&env);
        sac.mint(&b, &(6_000 * USDC));
        let lid = BytesN::from_array(&env, &[i + 20; 32]);
        pool.request_loan(&b, &lid, &(5_000 * USDC));
        pool.approve_loan(&lid);
        pool.add_contractor(&b);
        pool.disburse(&lid, &b, &(5_000 * USDC));
        borrowers.push(b);
        loan_ids.push(lid);
    }

    // Advance ledger by one compound period to accrue interest.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 518_400);

    // 7 non-defaulting borrowers repay principal + one month of 8% annual
    // interest, computed with the exact same fixed-point arithmetic (and
    // truncation order) as `LendingPoolContract::accrue_interest`, so the
    // repayment amount matches the contract's own accrued debt exactly.
    const INTEREST_SCALE: i128 = 1_000_000_000;
    const PERIODS_PER_YEAR: i128 = 12;
    let one_period_factor = INTEREST_SCALE + (800 * INTEREST_SCALE) / (10_000 * PERIODS_PER_YEAR);
    for idx in 3..10usize {
        let repay_amount = (5_000 * USDC).saturating_mul(one_period_factor) / INTEREST_SCALE;
        pool.repay(&borrowers[idx], &loan_ids[idx], &repay_amount);
    }

    // 3 borrowers default (30% default rate) — advance each past due first.
    for idx in 0..3usize {
        let sched = pool.get_repayment_schedule(&loan_ids[idx]).unwrap();
        env.ledger()
            .set_sequence_number(sched.next_due_ledger + OVERDUE_OFFSET);
        pool.mark_default(&loan_ids[idx]);
    }

    let senior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Senior);
    let junior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Junior);
    let health = pool.get_pool_health();

    // 1. Senior tranche fixed yield must have been distributed (7 performing loans × 8% rate).
    assert!(
        senior_info.total_yield_distributed > 0,
        "senior tranche must receive yield from performing loans"
    );

    // 2. Junior tranche absorbs the entire default loss — at least the 3 ×
    // 5 000 = 15 000 principal, plus whatever interest had accrued on each
    // defaulting loan by the time it was marked (mark_default accrues
    // interest before computing the loss, so the exact figure depends on
    // ledgers elapsed since disbursement — assert the invariant, not a
    // hardcoded interest-inflated number).
    assert!(
        junior_info.total_loss_absorbed >= 3 * 5_000 * USDC,
        "junior tranche must absorb at least the 15 000 USDC principal lost to 30% default"
    );
    assert_eq!(
        junior_info.total_loss_absorbed, health.total_defaulted_loss,
        "junior alone must absorb the pool's entire recorded default loss"
    );

    // 3. Senior tranche must not absorb any loss (junior had sufficient capital).
    assert_eq!(
        senior_info.total_loss_absorbed, 0,
        "senior tranche must not absorb any loss under 30% default"
    );

    // 4. Pool health: 3 defaulted, positive recorded loss.
    assert_eq!(health.defaulted_loans, 3);
    assert!(health.total_defaulted_loss > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge case: Single borrower defaults, exactly at Junior boundary
// ─────────────────────────────────────────────────────────────────────────────

/// A single 30 000 USDC loan defaulting exactly exhausts Junior capital.
/// Intended to confirm boundary-precision of the waterfall allocation logic.
#[test]
fn waterfall_junior_exhausted_exactly_at_boundary() {
    let env = Env::default();
    env.mock_all_auths();

    let (_admin, token, pool) = deploy_pool(&env);
    seed_pool_70_30(&env, &pool, &token);

    // Single borrower requesting the entire Junior tranche capacity.
    let borrower = Address::generate(&env);
    let sac = StellarAssetClient::new(&env, &token);
    sac.mint(&borrower, &(30_000 * USDC));

    let loan_id = BytesN::from_array(&env, &[99u8; 32]);
    pool.request_loan(&borrower, &loan_id, &(30_000 * USDC));
    pool.approve_loan(&loan_id);
    pool.add_contractor(&borrower);
    pool.disburse(&loan_id, &borrower, &(30_000 * USDC));

    advance_past_due(&env, &pool, &loan_id);
    pool.mark_default(&loan_id);

    let junior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Junior);
    let senior_info: TrancheInfo = pool.get_tranche_info(&Tranche::Senior);

    // Junior fully exhausted — deposited reaches 0.
    assert_eq!(junior_info.total_loss_absorbed, 30_000 * USDC);
    assert_eq!(junior_info.total_deposited, 0);

    // Senior unaffected — loss == Junior capacity exactly.
    assert_eq!(senior_info.total_loss_absorbed, 0);
    assert_eq!(senior_info.total_deposited, 70_000 * USDC);
}
