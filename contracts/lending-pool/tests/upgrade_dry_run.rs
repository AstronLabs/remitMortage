// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Upgrade dry run: replays stored state against a candidate wasm.
//!
//! Unit tests only ever see fresh state, so a storage layout change that breaks
//! loans already on chain would surface only after deployment. This test
//! rehearses the upgrade first:
//!
//! 1. deploy the **baseline** wasm (what is deployed today) in the test host;
//! 2. populate it with representative state: investors in both tranches, loans
//!    in every non-defaulted status, partial and full repayments with accrued
//!    interest, and pending requests (an unapproved loan, a queued cap change);
//! 3. read every stored value through the contract's views;
//! 4. upload the **candidate** wasm and run the contract's own `upgrade` and
//!    `migrate` calls;
//! 5. re-read everything through the candidate and require byte-identical
//!    results, with every persistent ledger entry untouched;
//! 6. keep operating on the old state with the candidate, including functions
//!    that only exist in it.
//!
//! The real run is `#[ignore]`d because it needs two wasm builds. Run it with
//! `make upgrade-dry-run` (see `contracts/lending-pool/README.md`). A native
//! self-check of the harness runs in plain `cargo test`.
//!
//! Values are compared as serialized XDR, not as Rust types, so a candidate
//! that changes a struct's layout fails here even if the field names still
//! line up.

use lending_pool::LendingPoolContract;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, IntoVal, Symbol, TryFromVal, Val,
};
use std::{env as std_env, fs};

/// 1 USDC in stroops (7 decimals).
const USDC: i128 = 10_000_000;
/// One compounding period / one repayment month, in production ledgers. Both
/// the wasm builds and the `lending_pool` rlib use production constants here.
const MONTH: u32 = 518_400;
const START_LEDGER: u32 = 1_000;

const BASE_WASM_VAR: &str = "UPGRADE_DRY_RUN_BASE_WASM";
const CANDIDATE_WASM_VAR: &str = "UPGRADE_DRY_RUN_CANDIDATE_WASM";

/// Zero-argument views that expose pool-wide configuration and counters.
/// `version` is deliberately absent: it is the one value an upgrade changes.
const POOL_VIEWS: &[&str] = &[
    "get_pool_config",
    "get_liquidity",
    "get_pool_health",
    "get_utilization",
    "get_withdrawal_fee_bps",
    "get_total_withdrawal_fees",
    "get_halving_info",
    "get_reward_multiplier_bps",
    "get_withdrawal_grace_ledgers",
    "get_utilization_pause_threshold",
    "is_utilization_auto_paused",
    "get_investor_deposit_cap",
    "get_deposit_cap_delay",
    "get_pending_investor_cap_change",
    "get_lockup_bonus_pool",
    "get_total_emergency_injected",
    "get_fee_switch_bps",
    "get_origination_fee_bps",
    "get_application_fee_bps",
    "get_total_application_fees",
    "get_prepay_waiver_ledgers",
    "get_prepayment_penalty_bps",
    "get_total_prepayment_penalties",
    "get_total_protocol_fees",
    "get_total_insurance_premiums",
    "get_daily_borrow_limit",
    "get_grace_period",
    "get_daily_penalty_bps",
    "get_late_fee_cap",
    "get_late_fee_lifetime_cap_bps",
    "get_daily_repayment_cap",
    "get_investor_tranche_share_cap",
    "get_rate_adjustment_caps",
    "get_min_deposit_amount",
    "get_borrower_exposure_cap",
    "get_borrower_active_loan_cap",
    "get_refinance_cooldown_ledgers",
    "get_rate_lock_window_ledgers",
    "get_max_single_withdrawal",
    "get_payoff_quote_window",
    "get_deposit_cooldown_ledgers",
    "get_permissioned_mode",
    "get_refinance_fee_config",
];

/// Views that must work on the baseline for the dry run to mean anything.
const REQUIRED_VIEWS: &[&str] = &["get_pool_config", "get_liquidity", "get_pool_health"];

// ── Harness ─────────────────────────────────────────────────────────────

/// Which implementation backs a deployed pool.
enum Build {
    /// The `lending_pool` crate compiled natively (harness self-check only).
    Native,
    /// A compiled wasm.
    Wasm(Vec<u8>),
}

struct Pool {
    env: Env,
    addr: Address,
    token: Address,
}

fn val<T: IntoVal<Env, Val>>(env: &Env, t: T) -> Val {
    t.into_val(env)
}

/// Builds a `soroban_sdk::Vec<Val>` of call arguments.
macro_rules! args {
    ($env:expr; $($a:expr),* $(,)?) => {
        soroban_sdk::vec![$env, $( val($env, $a.clone()) ),*]
    };
}

impl Pool {
    fn deploy(build: &Build) -> Pool {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        env.ledger().with_mut(|li| {
            li.sequence_number = START_LEDGER;
            // Room to jump forward a month without entries expiring.
            li.max_entry_ttl = 4_000_001;
            li.min_persistent_entry_ttl = 4_000_000;
        });

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let escrow = Address::generate(&env);
        let token = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let addr = match build {
            Build::Native => env.register(LendingPoolContract, ()),
            Build::Wasm(bytes) => env.register(bytes.as_slice(), ()),
        };

        let pool = Pool { env, addr, token };
        let e = &pool.env;
        pool.call::<()>(
            "initialize",
            args![e; admin, pool.token, escrow, 800u32, 400u32, treasury, 0u32, 0u32],
        );
        pool
    }

    fn call<R: TryFromVal<Env, Val>>(&self, func: &str, args: soroban_sdk::Vec<Val>) -> R {
        self.env
            .invoke_contract(&self.addr, &Symbol::new(&self.env, func), args)
    }

    /// The call's result serialized as XDR, or `None` if the call failed
    /// (including a function the contract does not have).
    fn view(&self, func: &str, args: soroban_sdk::Vec<Val>) -> Option<Bytes> {
        match self.env.try_invoke_contract::<Val, soroban_sdk::Error>(
            &self.addr,
            &Symbol::new(&self.env, func),
            args,
        ) {
            Ok(Ok(v)) => Some(v.to_xdr(&self.env)),
            _ => None,
        }
    }

    fn fund(&self, amount: i128) -> Address {
        let who = Address::generate(&self.env);
        StellarAssetClient::new(&self.env, &self.token).mint(&who, &amount);
        who
    }

    fn liquidity(&self) -> i128 {
        self.call("get_liquidity", args![&self.env;])
    }
}

/// Everything the scenario creates, so it can be re-read later.
struct Fixture {
    investors: Vec<Address>,
    borrowers: Vec<Address>,
    loans: Vec<BytesN<32>>,
    contractor: Address,
    /// Approved, disbursed, partly repaid.
    active_loan: BytesN<32>,
    active_borrower: Address,
    /// Requested but not yet approved: a pending request.
    pending_loan: BytesN<32>,
}

fn request_loan(pool: &Pool, seed: u8, principal: i128) -> (Address, BytesN<32>) {
    let e = &pool.env;
    let borrower = pool.fund(50_000 * USDC);
    let id = BytesN::from_array(e, &[seed; 32]);
    pool.call::<()>("request_loan", args![e; borrower, id, principal]);
    (borrower, id)
}

fn approve_and_disburse(pool: &Pool, contractor: &Address, id: &BytesN<32>, amount: i128) {
    let e = &pool.env;
    pool.call::<()>("approve_loan", args![e; id]);
    pool.call::<()>("disburse", args![e; id, contractor, amount]);
}

/// Builds representative state with the baseline.
fn populate(pool: &Pool) -> Fixture {
    let e = &pool.env;

    // Investors in both tranches.
    let senior = pool.fund(200_000 * USDC);
    let junior = pool.fund(100_000 * USDC);
    pool.call::<()>("deposit", args![e; senior, 80_000 * USDC, 0u32]);
    pool.call::<()>("deposit", args![e; junior, 30_000 * USDC, 1u32]);

    let contractor = Address::generate(e);
    pool.call::<()>("add_contractor", args![e; contractor]);

    // L1: approved, disbursed, repaid in part below.
    let (b1, l1) = request_loan(pool, 1, 10_000 * USDC);
    approve_and_disburse(pool, &contractor, &l1, 10_000 * USDC);
    // L2: approved, disbursed and repaid in full.
    let (b2, l2) = request_loan(pool, 2, 5_000 * USDC);
    approve_and_disburse(pool, &contractor, &l2, 5_000 * USDC);
    pool.call::<()>("repay", args![e; b2, l2, 5_000 * USDC]);
    // L3: still requested.
    let (b3, l3) = request_loan(pool, 3, 7_000 * USDC);
    // L4: rejected by the admin.
    let (b4, l4) = request_loan(pool, 4, 3_000 * USDC);
    pool.call::<()>("reject_loan", args![e; l4]);
    // L5: cancelled by the borrower.
    let (b5, l5) = request_loan(pool, 5, 2_000 * USDC);
    pool.call::<()>("cancel_loan", args![e; l5]);

    // A queued (not yet applied) tranche cap change.
    pool.call::<()>("set_deposit_cap_delay", args![e; 100_000u32]);
    pool.call::<()>("set_tranche_deposit_cap", args![e; 0u32, 500_000 * USDC]);

    // A month later, repay part of L1 so interest has compounded and the
    // schedule has advanced.
    e.ledger().set_sequence_number(START_LEDGER + MONTH);
    pool.call::<()>("repay", args![e; b1, l1, 2_000 * USDC]);

    Fixture {
        investors: vec![senior, junior],
        borrowers: vec![b1.clone(), b2, b3, b4, b5],
        loans: vec![l1.clone(), l2, l3.clone(), l4, l5],
        contractor,
        active_loan: l1,
        active_borrower: b1,
        pending_loan: l3,
    }
}

type State = Vec<(String, Option<Bytes>)>;

/// Reads every stored value the contract exposes, as XDR.
fn read_state(pool: &Pool, fx: &Fixture) -> State {
    let e = &pool.env;
    let mut out: State = Vec::new();
    let mut read = |label: String, func: &str, args: soroban_sdk::Vec<Val>| {
        out.push((label, pool.view(func, args)));
    };

    for func in POOL_VIEWS {
        read(func.to_string(), func, args![e;]);
    }
    for tranche in [0u32, 1u32] {
        for func in [
            "get_tranche_info",
            "debt_total_supply",
            "get_tranche_deposit_cap",
            "get_pending_tranche_cap_change",
        ] {
            read(format!("{func}({tranche})"), func, args![e; tranche]);
        }
    }
    for (i, investor) in fx.investors.iter().enumerate() {
        for func in [
            "get_investor_info",
            "get_pending_yield",
            "get_yield_mode",
            "get_investor_lockup",
            "get_withdrawable_amount",
        ] {
            read(format!("{func}(investor {i})"), func, args![e; investor]);
        }
        for tranche in [0u32, 1u32] {
            read(
                format!("debt_balance(investor {i}, {tranche})"),
                "debt_balance",
                args![e; investor, tranche],
            );
        }
    }
    for (i, loan) in fx.loans.iter().enumerate() {
        for func in [
            "get_loan_info",
            "get_repayment_schedule",
            "get_loan_borrower",
            "get_loan_late_fees",
            "get_restructure_proposal",
            "get_loan_extension_count",
            "get_application_fee",
            "get_payoff_quote",
        ] {
            read(format!("{func}(loan {i})"), func, args![e; loan]);
        }
    }
    for (i, borrower) in fx.borrowers.iter().enumerate() {
        for func in [
            "get_borrower_active_loans",
            "get_borrower_exposure",
            "get_borrower_lifetime_interest",
            "get_borrower_daily_repaid",
            "get_credit_line",
        ] {
            read(format!("{func}(borrower {i})"), func, args![e; borrower]);
        }
    }
    out
}

/// Every persistent contract-data entry in the ledger, as (key, value) debug
/// strings. Instance storage is excluded: it lives inside the contract
/// instance entry, which an upgrade legitimately rewrites (new executable,
/// bumped version), and is covered by the views in [`read_state`] instead.
fn persistent_entries(env: &Env) -> Vec<(String, String)> {
    env.to_ledger_snapshot()
        .ledger_entries
        .iter()
        .filter_map(|(key, (entry, _ttl))| {
            let key = format!("{key:?}");
            if !key.contains("ContractData") || key.contains("LedgerKeyContractInstance") {
                return None;
            }
            Some((key, format!("{:?}", entry.data)))
        })
        .collect()
}

/// Fails unless every value readable before is still readable and identical.
fn assert_state_unchanged(before: &State, after: &State) {
    assert_eq!(before.len(), after.len(), "the set of views changed");
    for ((label, was), (_, now)) in before.iter().zip(after) {
        // A view the baseline never had cannot be compared.
        if was.is_some() {
            assert!(
                was == now,
                "{label} reads differently after upgrade (or can no longer be read)"
            );
        }
    }
}

fn assert_entries_unchanged(before: &[(String, String)], after: &[(String, String)]) {
    for (key, value) in before {
        match after.iter().find(|(k, _)| k == key) {
            None => panic!("persistent entry missing after upgrade: {key}"),
            Some((_, now)) => assert!(
                now == value,
                "persistent entry changed by the upgrade: {key}\n  before: {value}\n  after:  {now}"
            ),
        }
    }
}

/// Keeps using the old state with the (possibly new) code, including
/// functions that exist only in the candidate.
///
/// **When a candidate adds a function that touches existing state, add a call
/// to it here.** `pay_principal` is the current example.
fn exercise_old_state(pool: &Pool, fx: &Fixture) {
    let e = &pool.env;
    let liquidity_before = pool.liquidity();

    // Existing function on old state: another installment on the old loan.
    pool.call::<()>(
        "repay",
        args![e; fx.active_borrower, fx.active_loan, 1_000 * USDC],
    );
    // Function added after the baseline, on a loan the baseline created.
    pool.call::<()>(
        "pay_principal",
        args![e; fx.active_borrower, fx.active_loan, 500 * USDC],
    );
    // Move a pending request through the rest of its life.
    approve_and_disburse(pool, &fx.contractor, &fx.pending_loan, 7_000 * USDC);
    // A fresh deposit on top of the old investor records.
    pool.call::<()>("deposit", args![e; fx.investors[0], 10_000 * USDC, 0u32]);

    // +1,000 repaid +500 principal +10,000 deposited -7,000 disbursed.
    assert_eq!(pool.liquidity(), liquidity_before + 4_500 * USDC);
}

/// The full rehearsal. With no `candidate`, no upgrade is performed and the
/// run only checks that the harness itself is sound.
fn run_dry_run(base: &Build, candidate: Option<&[u8]>) {
    let pool = Pool::deploy(base);
    let fx = populate(&pool);
    let e = &pool.env;

    let before = read_state(&pool, &fx);
    for required in REQUIRED_VIEWS {
        let found = before.iter().find(|(label, _)| label == required);
        assert!(
            found.map_or(false, |(_, v)| v.is_some()),
            "baseline does not answer {required}; the dry run would prove nothing"
        );
    }
    let entries_before = persistent_entries(e);
    assert!(
        entries_before.len() > 10,
        "expected the scenario to create many persistent entries, found {}",
        entries_before.len()
    );
    let version_before: u32 = pool.call("version", args![e;]);

    if let Some(wasm) = candidate {
        let hash = e.deployer().upload_contract_wasm(wasm);
        pool.call::<()>("upgrade", args![e; hash]);
        pool.call::<()>("migrate", args![e;]);

        let version_after: u32 = pool.call("version", args![e;]);
        assert_eq!(version_after, version_before + 1, "version was not bumped");
    }

    assert_state_unchanged(&before, &read_state(&pool, &fx));
    assert_entries_unchanged(&entries_before, &persistent_entries(e));

    exercise_old_state(&pool, &fx);
}

fn read_wasm(var: &str) -> Vec<u8> {
    let path = std_env::var(var)
        .unwrap_or_else(|_| panic!("{var} is not set; run `make upgrade-dry-run`"));
    fs::read(&path).unwrap_or_else(|e| panic!("cannot read {path} (from {var}): {e}"))
}

// ── Tests ───────────────────────────────────────────────────────────────

/// The real dry run: baseline wasm, upgraded to the candidate wasm.
#[test]
#[ignore = "needs two wasm builds; run with `make upgrade-dry-run`"]
fn upgrade_dry_run_replays_stored_state_against_candidate_wasm() {
    let base = read_wasm(BASE_WASM_VAR);
    let candidate = read_wasm(CANDIDATE_WASM_VAR);
    run_dry_run(&Build::Wasm(base), Some(&candidate));
}

/// Keeps the harness from rotting: the scenario runs against the native build
/// and every view it reads answers.
#[test]
fn harness_scenario_runs_against_the_current_code() {
    run_dry_run(&Build::Native, None);

    let pool = Pool::deploy(&Build::Native);
    let fx = populate(&pool);
    for (label, value) in read_state(&pool, &fx) {
        assert!(value.is_some(), "view {label} did not answer");
    }
}

/// The comparison must notice a changed value, otherwise the dry run could
/// pass vacuously.
#[test]
#[should_panic(expected = "reads differently after upgrade")]
fn harness_detects_a_value_that_reads_differently() {
    let pool = Pool::deploy(&Build::Native);
    let fx = populate(&pool);
    let before = read_state(&pool, &fx);

    // Stand-in for an upgrade that changes how stored values are read.
    let e = &pool.env;
    pool.call::<()>(
        "repay",
        args![e; fx.active_borrower, fx.active_loan, 100 * USDC],
    );

    assert_state_unchanged(&before, &read_state(&pool, &fx));
}

#[test]
#[should_panic(expected = "persistent entry changed by the upgrade")]
fn harness_detects_a_changed_persistent_entry() {
    let pool = Pool::deploy(&Build::Native);
    let fx = populate(&pool);
    let before = persistent_entries(&pool.env);

    let e = &pool.env;
    pool.call::<()>(
        "repay",
        args![e; fx.active_borrower, fx.active_loan, 100 * USDC],
    );

    assert_entries_unchanged(&before, &persistent_entries(&pool.env));
}
