// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

//! Budget benchmark for interest accrual (`accrue_interest`).
//!
//! Soroban transactions have hard per-transaction limits — 100 000 000 CPU
//! instructions and 40 MiB of memory on the network today. Interest accrual
//! runs on every repayment, disbursement, refinance and default path, so its
//! resource cost must stay well within those limits.
//!
//! This benchmark measures the CPU instructions and memory consumed by
//! `LendingPoolContract::accrue_interest` across a range of loan ages and
//! payment histories, then fails when a change pushes cost beyond a
//! documented margin of the committed baseline.
//!
//! ## Running
//!
//! ```bash
//! cd contracts
//! cargo test -p lending-pool --lib bench_accrual -- --nocapture
//! ```
//!
//! ## Recording / updating baselines
//!
//! The `BASE_*` constants below start at zero (un-recorded). Record real
//! values on the first run:
//!
//! ```bash
//! cd contracts
//! BUDGET_UPDATE=1 cargo test -p lending-pool --lib bench_accrual -- --nocapture
//! ```
//!
//! Copy the printed values into the `BASE_*` constants, explain every
//! increase over the tolerance in the PR description, and commit them with
//! the code change. See `docs/CONTRACT_BUDGET_REGRESSION.md` for the full
//! workflow.
//!
//! Costs come from native (non-Wasm) test execution, so absolute numbers
//! underestimate on-chain cost; the baselines track *relative* change.

extern crate std;

use super::*;
use crate::test_support::{funded, setup};
use crate::types::Tranche;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    Address, BytesN, Env,
};

// ── Configuration ───────────────────────────────────────────────────────

/// Allowed cost growth over the baseline before the benchmark fails, in
/// percent. Mirrors `budget-tests/budget-config.json::tolerance_pct` with a
/// small margin for native-test variance.
const TOLERANCE_PCT: u64 = 15;

/// Growth below these absolute amounts is ignored so tiny functions do not
/// flap. Mirrors `budget-config.json::min_abs_*`.
const MIN_ABS_CPU: u64 = 20_000;
const MIN_ABS_MEM: u64 = 4_096;

/// Soroban per-transaction network limits.
const NETWORK_LIMIT_CPU: u64 = 100_000_000;
const NETWORK_LIMIT_MEM: u64 = 41_943_040;

/// Fail when usage reaches this share (percent) of a network limit.
const FAIL_PCT: u64 = 80;

/// One compounding period in test builds (`COMPOUND_PERIOD = 100` ledgers,
/// set in `lib.rs` under `#[cfg(test)]`).
const PERIOD_LEDGERS: u32 = 100;

// ── Recorded baselines ─────────────────────────────────────────────────
//
// Replace the zeros with the values printed by:
//
//   BUDGET_UPDATE=1 cargo test -p lending-pool --lib bench_accrual -- --nocapture
//
// A zero baseline means "not yet recorded"; the regression check is skipped
// until a real value is committed, but the network-limit gate is always on.

/// Representative case — one compounding period.
const BASE_REP_CPU: u64 = 0;
const BASE_REP_MEM: u64 = 0;

/// Mid-age — 12 compounding periods (≈ one year of monthly compounding).
const BASE_MID_CPU: u64 = 0;
const BASE_MID_MEM: u64 = 0;

/// Worst case — ~39 000 compounding periods (long idle gap).
const BASE_WORST_CPU: u64 = 0;
const BASE_WORST_MEM: u64 = 0;

/// After partial repayment — accrue on a reduced balance.
const BASE_REPAY_CPU: u64 = 0;
const BASE_REPAY_MEM: u64 = 0;

// ── Helpers ────────────────────────────────────────────────────────────

/// Deposit liquidity and disburse a 50 000-unit loan so `outstanding_debt`
/// is positive and interest can accrue. Returns the borrower (for repayments)
/// and the loan ID.
fn create_disbursed_loan(
    env: &Env,
    pool: &crate::test_support::Pool,
    id_byte: u8,
) -> (Address, BytesN<32>) {
    let client = &pool.client;

    let investor = funded(env, pool, 200_000);
    client.deposit(&investor, &200_000, &Tranche::Senior);

    let borrower = funded(env, pool, 500_000);
    let contractor = Address::generate(env);
    client.add_contractor(&contractor);
    let loan_id = BytesN::from_array(env, &[id_byte; 32]);
    client.request_loan(&borrower, &loan_id, &50_000);
    client.approve_loan(&loan_id);
    client.disburse(&loan_id, &contractor, &50_000);

    (borrower, loan_id)
}

/// Measure the CPU instructions and memory consumed by one `accrue_interest`
/// call. The `get_loan_info` read happens *outside* the budget window so only
/// the accrual itself is measured.
fn measure_accrue(
    env: &Env,
    client: &LendingPoolContractClient,
    loan_id: &BytesN<32>,
) -> (u64, u64) {
    let mut loan = client.get_loan_info(loan_id);
    let mut budget = env.cost_estimate().budget();
    budget.reset_unlimited();
    env.as_contract(&client.address, || {
        LendingPoolContract::accrue_interest(env, &mut loan);
    });
    (budget.cpu_instruction_cost(), budget.memory_bytes_cost())
}

/// Check one measurement against the network limit and the committed
/// baseline. In `BUDGET_UPDATE=1` mode, prints the values to record instead
/// of checking.
fn check(label: &str, cpu: u64, mem: u64, base_cpu: u64, base_mem: u64) {
    let update = std::env::var("BUDGET_UPDATE")
        .map(|v| v == "1")
        .unwrap_or(false);

    if update {
        std::eprintln!("BUDGET_UPDATE  {label}:  cpu = {cpu}  mem = {mem}");
        return;
    }

    // Network-limit gate — always enforced, even before baselines are recorded.
    if cpu.saturating_mul(100) >= NETWORK_LIMIT_CPU.saturating_mul(FAIL_PCT) {
        panic!(
            "{label}: CPU {cpu} >= {FAIL_PCT}% of the network limit ({NETWORK_LIMIT_CPU})"
        );
    }
    if mem.saturating_mul(100) >= NETWORK_LIMIT_MEM.saturating_mul(FAIL_PCT) {
        panic!(
            "{label}: memory {mem} >= {FAIL_PCT}% of the network limit ({NETWORK_LIMIT_MEM})"
        );
    }

    // Baseline regression — skipped until a real baseline is committed.
    if base_cpu == 0 && base_mem == 0 {
        std::eprintln!(
            "{label}: no baseline (cpu {cpu}, mem {mem}); run with BUDGET_UPDATE=1 to record"
        );
        return;
    }

    let cpu_allowed = base_cpu + base_cpu * TOLERANCE_PCT / 100;
    if cpu > cpu_allowed && cpu - base_cpu > MIN_ABS_CPU {
        panic!(
            "{label}: CPU {cpu} exceeds baseline {base_cpu} by more than {TOLERANCE_PCT}% \
             (allowed {cpu_allowed}); if intentional, re-record with BUDGET_UPDATE=1"
        );
    }

    let mem_allowed = base_mem + base_mem * TOLERANCE_PCT / 100;
    if mem > mem_allowed && mem - base_mem > MIN_ABS_MEM {
        panic!(
            "{label}: memory {mem} exceeds baseline {base_mem} by more than {TOLERANCE_PCT}% \
             (allowed {mem_allowed}); if intentional, re-record with BUDGET_UPDATE=1"
        );
    }
}

// ── Benchmark ──────────────────────────────────────────────────────────

/// Measures `accrue_interest` cost across a range of loan ages and payment
/// histories, and fails when cost grows past the tolerance or approaches the
/// network limit.
#[test]
fn accrue_interest_budget() {
    // ── Representative: one compounding period (100 ledgers in test mode) ──
    {
        let env = Env::default();
        let pool = setup(&env);
        let (_, loan_id) = create_disbursed_loan(&env, &pool, 7);
        let client = &pool.client;

        env.ledger().with_mut(|li| li.sequence_number += PERIOD_LEDGERS);
        let (cpu, mem) = measure_accrue(&env, client, &loan_id);
        check("representative (1 period)", cpu, mem, BASE_REP_CPU, BASE_REP_MEM);
    }

    // ── Mid-age: 12 compounding periods (1 200 ledgers ≈ one year) ──
    {
        let env = Env::default();
        let pool = setup(&env);
        let (_, loan_id) = create_disbursed_loan(&env, &pool, 7);
        let client = &pool.client;

        env.ledger().with_mut(|li| li.sequence_number += 12 * PERIOD_LEDGERS);
        let (cpu, mem) = measure_accrue(&env, client, &loan_id);
        check("mid-age (12 periods)", cpu, mem, BASE_MID_CPU, BASE_MID_MEM);
    }

    // ── Worst case: ~39 000 compounding periods (3 900 000 ledgers) ──
    //
    // The longest idle gap that stays within the 4 000 000-ledger TTL set by
    // `test_support::setup`. The cost driver is `compound_pow`, whose
    // iteration count is O(bit-length of the period count) — a long gap
    // exercises the most iterations and the most memory.
    {
        let env = Env::default();
        let pool = setup(&env);
        let (_, loan_id) = create_disbursed_loan(&env, &pool, 7);
        let client = &pool.client;

        env.ledger().with_mut(|li| li.sequence_number += 3_900_000);
        let (cpu, mem) = measure_accrue(&env, client, &loan_id);
        check("worst case (39k periods)", cpu, mem, BASE_WORST_CPU, BASE_WORST_MEM);
    }

    // ── After partial repayment: accrue on a reduced balance ──
    //
    // A real payment history halves the outstanding debt mid-life, so the
    // subsequent accrue runs on a smaller principal with a reset
    // `last_interest_ledger`.
    {
        let env = Env::default();
        let pool = setup(&env);
        let (borrower, loan_id) = create_disbursed_loan(&env, &pool, 7);
        let client = &pool.client;

        // Accrue 5 periods, then repay half the debt (repay accrues + reduces).
        env.ledger().with_mut(|li| li.sequence_number += 5 * PERIOD_LEDGERS);
        let loan = client.get_loan_info(&loan_id);
        let half = loan.outstanding_debt / 2;
        client.repay(&borrower, &loan_id, &half);

        // Advance 5 more periods and measure accrual on the reduced balance.
        env.ledger().with_mut(|li| li.sequence_number += 5 * PERIOD_LEDGERS);
        let (cpu, mem) = measure_accrue(&env, client, &loan_id);
        check("after partial repayment", cpu, mem, BASE_REPAY_CPU, BASE_REPAY_MEM);
    }
}
