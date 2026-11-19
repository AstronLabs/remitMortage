// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, BytesN, Symbol};

/// Pending upgrade proposal (used when upgrade_delay_ledgers > 0).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpgradeRecord {
    /// The WASM hash queued for deployment.
    pub new_wasm_hash: BytesN<32>,
    /// The ledger sequence after which this upgrade may execute.
    pub execute_after: u32,
}

/// A pending, timelocked change to an asset class's collateral haircut.
/// The asset class itself is the storage key (`FeatureKey::PendingHaircutChange`),
/// not stored redundantly here.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingHaircutChange {
    /// The haircut value queued to take effect.
    pub haircut_bps: u32,
    /// The ledger sequence after which this change may execute.
    pub execute_after: u32,
}

/// A pending, timelocked change to a deposit cap (per tranche or per
/// investor). Which cap it applies to is encoded in the storage key it is
/// held under (`FeatureKey::PendingTrancheCap` / `PendingInvestorCap`).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingCapChange {
    /// The cap value queued to take effect. `0` removes the cap.
    pub cap: i128,
    /// The ledger sequence after which this change may be executed.
    pub execute_after: u32,
}

/// What an investor's position does with the yield it earns.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum YieldMode {
    /// Yield is paid out to the investor by `claim_yield`. The default.
    Claim = 0,
    /// Yield is added to the position's principal, in the same tranche, by
    /// `compound_yield`.
    Compound = 1,
}

/// Lifecycle state of the pool's orderly wind-down process.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum WindDownStatus {
    /// Normal operation: deposits, loan requests and withdrawals all work
    /// exactly as they always have.
    Active = 0,
    /// New deposits and loan requests are rejected; repayments continue;
    /// investors withdraw via `withdraw_during_wind_down`, pro rata by
    /// tranche seniority, as liquidity returns.
    WindingDown = 1,
    /// All loans have been resolved (`ActiveLoanCommitments == 0`) and
    /// `finalize_wind_down` has been called. Withdrawals continue to be
    /// available until every investor has been paid out.
    Finalized = 2,
}

/// A pending, timelocked proposal to start wind-down.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingWindDown {
    /// The ledger sequence after which wind-down may actually start.
    pub execute_after: u32,
}

/// Tranche types for risk stratification of investor deposits.
///
/// Senior tranche offers a lower, fixed yield rate but is protected from losses.
/// Junior tranche absorbs first losses in exchange for higher, variable yield.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum Tranche {
    /// Lower fixed yield, protected from losses until junior is exhausted.
    Senior = 0,
    /// Higher variable yield, absorbs losses before senior tranche.
    Junior = 1,
}

/// Pool configuration set during initialization.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolConfig {
    /// Admin address with authority to approve loans and manage the pool.
    pub admin: Address,
    /// USDC token contract address.
    pub token: Address,
    /// Escrow contract address for the savings target.
    pub escrow: Address,
    /// Annual interest rate in basis points (e.g. 800 = 8%).
    pub interest_rate_bps: u32,
    /// Fixed yield rate allocated to senior tranche in basis points (e.g. 400 = 4%).
    pub senior_rate_bps: u32,
    /// Protocol treasury address where withdrawal fees are routed.
    pub treasury_address: Address,
    /// Protocol fee switch, in basis points, taken from loan interest before
    /// it reaches investors. `0` — the deployment default — leaves the switch
    /// off so every unit of interest flows to the tranches. Mutable only via
    /// `set_fee_switch_bps`, which is gated behind the governance multisig.
    pub fee_switch_bps: u32,
    /// Loan origination fee, in basis points, deducted from each disbursement
    /// and routed to `treasury_address`. Loan accounting remains gross.
    pub origination_fee_bps: u32,
    /// Loan application (processing) fee, in basis points of the requested
    /// principal, collected from the borrower when the application is
    /// submitted. Unlike the origination fee — which is taken out of the
    /// disbursement and is only ever payable by a loan that reaches funds —
    /// the application fee is paid up front, before any credit decision, so
    /// it is escrowed by the pool against that application until a final
    /// decision is reached:
    ///
    /// * `approve_loan` retains it and routes it to `treasury_address`.
    /// * `reject_loan` and `cancel_loan` refund it in full to the borrower
    ///   automatically, in the same transaction as the transition.
    ///
    /// The escrowed tokens are never booked as pool liquidity, so settling
    /// the fee in either direction leaves investor accounting untouched.
    ///
    /// `0` — the deployment default — charges no application fee at all, so
    /// existing integrations are unaffected until an admin opts in via
    /// `set_application_fee_bps`.
    pub application_fee_bps: u32,
    /// How long a borrower must have held an escrow savings relationship
    /// before their early-prepayment penalty is waived, measured in ledgers
    /// at the moment the loan was originated.
    ///
    /// The waiver is a loyalty reward for borrowers who actually built their
    /// down payment through the escrow savings programme, rather than a
    /// discount handed to anyone who takes a loan. A borrower whose recorded
    /// relationship age meets this threshold pays no penalty when `repay`
    /// closes their loan ahead of schedule; anyone below it is charged the
    /// standard penalty unchanged. Because it only forgives a fee and never
    /// touches principal or interest, waiving it does not erode the pool's
    /// interest revenue.
    ///
    /// The age is latched onto the loan at origination
    /// (`LoanRecord::escrow_relationship_ledgers`) from the relationship start
    /// recorded by the escrow bridge, so a borrower cannot change their own
    /// eligibility mid-loan by opening or extending an escrow account. The
    /// threshold in force at repayment is the one applied, so governance
    /// changes still take effect on loans that are already running.
    ///
    /// `0` — the deployment default — disables the waiver entirely, so every
    /// borrower is charged the standard penalty until an admin opts in via
    /// `set_prepay_waiver_ledgers`. `0` cannot mean "waive
    /// everyone": a borrower with no escrow relationship records an age of
    /// `0`, and the two must not collide.
    ///
    /// Named `prepay_waiver_ledgers` rather than the longer
    /// `prepayment_penalty_waiver_ledgers` because Soroban caps contract-type
    /// field names at 30 characters.
    pub prepay_waiver_ledgers: u32,
    /// Minimum number of ledgers an LP's deposit must remain in the pool
    /// before a withdrawal is allowed. 0 means no lockup.
    pub lockup_duration_ledgers: u32,
    /// Smallest deposit the pool will accept from an investor, in token
    /// stroops. Guards against storage-bloat griefing: without a floor an
    /// attacker can flood `deposit` with negligible amounts, each one writing
    /// or touching an `InvestorRecord` and the tranche aggregates.
    ///
    /// `0` — the deployment default — disables the floor entirely, so existing
    /// behaviour is unchanged until an admin opts in via
    /// `set_min_deposit_amount`.
    pub min_deposit_amount: i128,
    /// Maximum number of simultaneously active loans (in `Requested` or
    /// `Approved` state) a single borrower address may hold. Caps protocol
    /// risk concentration on any one borrower.
    ///
    /// `0` — the deployment default — disables the cap entirely, so existing
    /// behaviour is unchanged until an admin opts in via
    /// `set_borrower_active_loan_cap`.
    pub max_active_loans_per_borrower: u32,
    /// Minimum number of ledgers between consecutive refinancing requests on
    /// the same loan. Prevents borrowers from repeatedly refinancing in short
    /// succession to game interest rate timing. `0` disables the cooldown.
    pub refinance_cooldown_ledgers: u32,
    /// Maximum amount withdrawable by an investor in a single `withdraw`
    /// call, in token stroops. Caps the blast radius of a compromised key
    /// or contract bug: a larger position must be withdrawn across multiple
    /// transactions rather than drained in one call.
    ///
    /// `0` — the deployment default — disables the cap entirely, so existing
    /// behaviour is unchanged until an admin opts in via
    /// `set_max_single_withdrawal`.
    pub max_single_withdrawal: i128,
    /// Minimum number of ledgers that must elapse between an investor's
    /// consecutive deposits.  Prevents rapid-fire deposit spam that could
    /// grief pool accounting or exploit a buggy integration retry loop.
    ///
    /// `0` — the deployment default — disables the cooldown entirely, so
    /// existing behaviour is unchanged until an admin opts in via
    /// `set_deposit_cooldown_ledgers`.
    pub deposit_cooldown_ledgers: u32,
    /// Number of ledgers after a `request_refinance` call during which the
    /// quoted rate is guaranteed.  `execute_refinance` is rejected once this
    /// window has elapsed; the borrower must re-request to obtain a fresh
    /// quote.
    ///
    /// `0` — the deployment default — means no expiry is enforced: the lock
    /// holds indefinitely until executed or superseded.  Set a non-zero value
    /// via `set_rate_lock_window_ledgers` to opt in.
    pub rate_lock_window_ledgers: u32,
    /// Maximum share of the insurance pool's current reserves that a single
    /// `inject_emergency_liquidity` call may draw, expressed in basis points
    /// (e.g. 2000 = 20 %).
    ///
    /// `0` — the deployment default — disables the cap entirely (no per-call
    /// ceiling beyond the pool's actual reserve balance).  Set a non-zero
    /// value via `set_emergency_injection_cap_bps` to opt in.
    pub emergency_injection_cap_bps: u32,
    /// When true, only whitelisted addresses may call deposit, request_loan,
    /// and withdraw. Toggleable by admin for regulated or pilot deployments.
    /// `false` — the deployment default — preserves existing permissionless
    /// behaviour.
    pub permissioned_mode: bool,
    /// Minimum holding period, in ledgers, after which an investor's
    /// withdrawal is waived of the early-redemption (utilization-based
    /// withdrawal) fee. Holding duration is measured from the investor's
    /// `start_ledger` to the current ledger at withdrawal time.
    /// `0` — the deployment default — disables the waiver so every
    /// withdrawal pays the fee exactly as before.
    pub redemption_fee_waiver_ledgers: u32,
    /// Fixed window, in ledgers, for which a `quote_payoff` snapshot stays
    /// valid. A payoff executed within the window settles at exactly the
    /// quoted amount. `0` disables quoting (quotes cannot be created).
    pub payoff_quote_window_ledgers: u32,
}

/// Tracks an individual investor's capital contribution.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvestorRecord {
    /// Total deposited by this investor.
    pub deposited: i128,
    /// Yield already claimed by this investor.
    pub claimed_yield: i128,
    /// Ledger when first deposit was made.
    pub start_ledger: u32,
    /// The tranche this investor deposited into.
    pub tranche: Tranche,
    /// Accumulated yield credited to this investor (not yet withdrawn).
    pub accrued_yield: i128,
    /// Total losses absorbed by this investor (only non-zero for junior tranche).
    pub absorbed_loss: i128,
    /// Optional first-loss cap in basis points for junior deposits (e.g. 1000 = 10% max loss exposure).
    /// None or 10000 means 100% (full exposure).
    pub first_loss_cap_bps: Option<u32>,
}

/// Per-tranche aggregate metrics stored in instance storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TrancheInfo {
    /// Total capital deposited into this tranche.
    pub total_deposited: i128,
    /// Total yield distributed to this tranche so far.
    pub total_yield_distributed: i128,
    /// Total losses absorbed by this tranche so far.
    pub total_loss_absorbed: i128,
}

/// Loan status lifecycle.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum LoanStatus {
    /// Loan has been requested but not yet approved.
    Requested = 0,
    /// Loan is approved and funds can be disbursed in milestones.
    Approved = 1,
    /// Loan has been fully repaid.
    Repaid = 2,
    /// Loan was rejected or cancelled.
    Cancelled = 3,
    /// Loan defaulted — losses are distributed via the waterfall.
    /// Loan has defaulted after missed payments.
    Defaulted = 4,
    /// The admin rejected this application. Terminal, and distinct from
    /// `Cancelled` so a credit decision is distinguishable on-chain from a
    /// borrower withdrawing their own request. Any application fee escrowed
    /// at submission is refunded to the borrower on entry to this state.
    Rejected = 5,
}

/// Repayment schedule for a loan, tracked on-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RepaymentSchedule {
    /// Monthly installment amount (principal + interest portion for the term).
    pub monthly_amount: i128,
    /// Duration of the schedule in months.
    pub duration_months: u32,
    /// Ledger sequence when the next installment is due.
    pub next_due_ledger: u32,
    /// Count of installments paid on-time.
    pub payments_made: u32,
    /// Count of installments missed (consecutive misses are used for default detection).
    pub payments_missed: u32,
}

/// A loan record for a borrower.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanRecord {
    /// The borrower's address.
    pub borrower: Address,
    /// Total loan principal (the 70% amount).
    pub principal: i128,
    /// Amount already disbursed to contractors/suppliers.
    pub disbursed: i128,
    /// Amount repaid by the borrower so far.
    pub repaid: i128,
    /// Interest rate in basis points (snapshot from pool config at creation).
    pub interest_rate_bps: u32,
    /// Current loan status.
    pub status: LoanStatus,
    /// Ledger when the loan was created.
    pub created_ledger: u32,
    // schedule moved to separate storage key (LoanSchedule) to avoid optional contracttype encoding issues
    /// Ledger sequence when compound interest was last accrued.
    pub last_interest_ledger: u32,
    /// Total outstanding debt including compounded interest, minus repayments.
    pub outstanding_debt: i128,
    /// Ledger sequence when the loan was marked defaulted (0 if never defaulted).
    pub defaulted_ledger: u32,
    /// Optional escrow contract address that originated this loan via the bridge.
    pub escrow_origin: Option<Address>,
    /// Age of the borrower's escrow savings relationship at the moment this
    /// loan was originated, in ledgers. `0` means the borrower had no
    /// recorded relationship.
    ///
    /// Latched at origination rather than read at repayment time so that the
    /// early-prepayment penalty a borrower is assessed cannot be changed after
    /// the fact by opening or closing an escrow account. See
    /// `PoolConfig::prepay_waiver_ledgers` for how it is used.
    pub escrow_relationship_ledgers: u32,
    /// Ledger sequence when the loan was refinanced.
    pub refinanced_at_ledger: Option<u32>,
    /// Previous interest rate before refinancing.
    pub previous_rate_bps: Option<u32>,
}

/// Aggregate solvency metrics for the pool, returned by `get_pool_health`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolHealth {
    /// Total liquidity currently held by the pool.
    pub total_liquidity: i128,
    /// Outstanding capital committed to approved (active) loans.
    pub active_loan_commitments: i128,
    /// Total number of loans ever created.
    pub total_loans: u32,
    /// Number of loans that have been marked defaulted.
    pub defaulted_loans: u32,
    /// Net realized loss from defaults, after any recoveries.
    pub total_defaulted_loss: i128,
    /// Default rate (defaulted_loans / total_loans) in basis points.
    pub default_rate_bps: u32,
    /// Loss ratio (total_defaulted_loss / total_deposited) in basis points.
    pub loss_ratio_bps: u32,
}

/// Snapshot of the halving state, returned by `get_halving_info`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct HalvingInfo {
    /// Number of ledgers between each halving epoch (e.g. 5_000_000).
    pub halving_interval: u32,
    /// Ledger sequence at which the most recent halving occurred (or the
    /// pool initialisation ledger for the very first epoch).
    pub last_halving_ledger: u32,
    /// Current epoch index (0 = genesis, 1 = after first halving, …).
    pub epoch: u32,
    /// Current reward multiplier in basis points
    /// (10_000 = 100 %, 5_000 = 50 %, 2_500 = 25 %, …).
    pub reward_multiplier_bps: u32,
    /// Ledger sequence at which the *next* halving will fire.
    pub next_halving_ledger: u32,
}

/// A pending debt restructuring proposal for a loan, submitted by the borrower
/// and awaiting admin multisig approval. Once approved, the loan's repayment
/// schedule is replaced with the proposed schedule and penalty counters reset.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RestructureProposal {
    pub new_schedule: RepaymentSchedule,
    pub proposed_at_ledger: u32,
}

/// Rate-lock snapshot recorded when a refinance is requested.
///
/// The locked rate is guaranteed to apply on `execute_refinance` as long as
/// the call arrives before `lock_expiry_ledger`.  After that ledger the
/// borrower must call `request_refinance` again to obtain a fresh quote.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RefinanceRateLock {
    /// The interest rate (bps) quoted at request time.  This is the rate that
    /// will be written to the loan on a successful `execute_refinance`.
    pub locked_rate_bps: u32,
    /// Proposed new term length in months, also locked at request time.
    pub locked_duration_months: u32,
    /// Ledger sequence at or before which `execute_refinance` must be called.
    /// A call arriving at a ledger strictly greater than this value is
    /// rejected with `RefinanceRateLockExpired`.
    pub lock_expiry_ledger: u32,
    /// Ledger at which the request was made, used for event attribution.
    pub requested_at_ledger: u32,
}

/// An individual item in a batch disbursement request.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchDisburseItem {
    pub loan_id: BytesN<32>,
    pub recipient: Address,
    pub amount: i128,
}

/// Self-contained representation of a loan moved between compatible pools.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanPortabilitySnapshot {
    pub source_pool: Address,
    pub loan_id: BytesN<32>,
    pub loan: LoanRecord,
    pub schedule: RepaymentSchedule,
    pub schedule_present: bool,
    pub exported_at_ledger: u32,
}

/// Storage keys for the lending pool contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Pool configuration.
    Config,
    /// Investor record keyed by investor address.
    Investor(Address),
    /// Transferable senior/junior principal-claim balance.
    DebtBalance(Address, Tranche),
    /// Total debt-share supply for a tranche.
    DebtTotalSupply(Tranche),
    /// Total available liquidity in the pool.
    TotalLiquidity,
    /// Loan record keyed by a unique loan ID (hash).
    Loan(BytesN<32>),
    /// Repayment schedule keyed by loan ID.
    LoanSchedule(BytesN<32>),
    /// Total number of active loans (for tracking).
    LoanCount,
    /// Aggregate info for the senior tranche.
    SeniorTranche,
    /// Aggregate info for the junior tranche.
    JuniorTranche,
    /// Total interest repaid to the pool.
    TotalRepaidInterest,
    /// Net realized loss from defaulted loans, reduced by recoveries.
    TotalDefaultedLoss,
    /// Number of loans that have been marked defaulted.
    DefaultedLoanCount,
    /// Sum of all principal - disbursed for Approved loans.
    ActiveLoanCommitments,
    /// Sum of all investor deposits minus withdrawals.
    TotalDeposited,
    /// Current contract version (incremented on each upgrade).
    Version,
    /// Pending upgrade proposal (present only when a timelock delay is active).
    PendingUpgrade,
    /// Number of ledgers the admin must wait between proposing and executing an upgrade.
    UpgradeDelay,
    /// Emergency pause flag. When true, state-mutating operations are blocked.
    Paused,
    /// Pending new admin address for two-step admin transfer.
    PendingAdmin,
    /// Total withdrawal fees collected and routed to treasury.
    TotalWithdrawalFees,
    /// Ledger at which a borrower's escrow savings relationship began, as
    /// recorded by the escrow bridge. Used to derive the relationship age that
    /// gets latched onto a loan at origination, which in turn gates the
    /// early-prepayment penalty waiver. A missing entry means the borrower has
    /// no recorded relationship and latches an age of `0`.
    EscrowRelationshipStart(Address),
    /// Total early-prepayment penalties collected and routed to treasury.
    /// Excludes penalties waived for loyalty, which are never charged.
    TotalPrepaymentPenalties,
    /// Application (processing) fee escrowed for a loan, keyed by loan ID.
    /// Present only while a `Requested` loan is awaiting a final decision;
    /// removed as soon as the fee is settled — retained by `approve_loan`,
    /// or refunded by `reject_loan` / `cancel_loan`. A missing entry means
    /// either no fee was collected or it has already been settled.
    ApplicationFee(BytesN<32>),
    /// Lifetime application fees retained by the protocol, i.e. collected on
    /// applications that went on to be approved. Refunded fees are never
    /// counted here.
    TotalApplicationFees,
    /// Lifetime protocol fees skimmed from interest by the fee switch and
    /// routed to the treasury.
    TotalProtocolFees,
    /// Address of the VerificationRegistry contract used to resolve borrower
    /// interest rates during loan requests. Absent until `set_verification_registry`
    /// is called by the admin.
    VerificationRegistry,
    /// Address of the InsurancePool contract that receives the 5 bps
    /// disbursement premium. Absent until `set_insurance_pool` is called by
    /// the admin, in which case no premium is skimmed.
    InsurancePool,
    /// Total insurance premiums skimmed from disbursements and routed to the
    /// insurance fund.
    TotalInsurancePremiums,
    /// Global daily borrow limit.
    DailyBorrowLimit,
    /// Tracks total amount borrowed in a specific daily window (day_id).
    DailyBorrowed(u32),
    /// Configurable grace period (in ledgers) after an installment's due date
    /// before late penalties accrue.
    GracePeriodLedgers,
    /// Per-day late-payment penalty rate in basis points.
    DailyPenaltyBps,
    /// Whitelist flag for a contractor address. Present and `true` means the
    /// address is a vetted recipient eligible to receive disbursements.
    Whitelist(Address),
    /// Reentrancy guard flag. Present and `true` when a reentrancy-sensitive
    /// operation is in progress.
    ReentrancyGuard,
    /// A pending debt restructuring proposal, keyed by loan ID.
    RestructureProposal(BytesN<32>),
    /// Address of the MultisigValidator contract used for admin multisig
    /// approval of restructuring and other privileged operations.
    MultisigValidator,
    // ── Reward Halving ──────────────────────────────────────────────────
    /// Number of ledgers between each halving epoch. Set once during
    /// `initialize` and never mutated (immutable schedule parameter).
    HalvingInterval,
    /// Ledger sequence at which the most recent epoch transition occurred.
    /// Seeded to the pool's initialisation ledger; updated on each halving.
    LastHalvingLedger,
    /// Zero-based epoch counter. Incremented on every halving event.
    HalvingEpoch,
    /// Lifetime interest paid by a borrower, keyed by borrower address.
    BorrowerLifetimeInterest(Address),
    /// Count of currently-active loans (in `Requested` or `Approved` state)
    /// held by a borrower, keyed by borrower address. Used to enforce
    /// `max_active_loans_per_borrower`.
    BorrowerActiveLoans(Address),
    /// Tracks whether a loan's maturity rebate has been claimed.
    LoanRebateClaimed(BytesN<32>),
    /// Collateral tracking for a loan (partial releases).
    LoanCollateral(BytesN<32>),
    /// Maps a loan Symbol to its canonical BytesN<32> loan ID.
    LoanSymbolMap(Symbol),
    /// Pending loan assumption request, keyed by loan ID.
    LoanAssumption(BytesN<32>),
    /// Locked payoff quote for a loan, keyed by loan ID.
    PayoffQuote(BytesN<32>),
}

/// Storage keys for newer pool features.
///
/// Kept apart from [`DataKey`] because Soroban caps a `#[contracttype]` union
/// at 50 cases and `DataKey` is already at that ceiling.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum FeatureKey {
    /// Tranche seniority order the yield distribution waterfall processes
    /// in. Absent under normal operation — the default `[Senior, Junior]` is
    /// never written to storage by any current code path; this key exists
    /// so tests can deliberately override it to simulate a misconfigured or
    /// upgraded distribution routine and confirm the priority-order guard in
    /// `repay` catches it. See `LendingPoolContract::assert_waterfall_priority_order`.
    WaterfallOrder,
    /// Ledger sequence of the most recent deposit for an investor address.
    /// Absent until the investor makes their first deposit.
    /// Used to enforce `deposit_cooldown_ledgers`.
    InvestorLastDeposit(Address),
    /// Rate-lock snapshot stored when `request_refinance` is called.
    /// Cleared on successful `execute_refinance` or when superseded by a
    /// new request.  Keyed by loan ID.
    RefinanceRateLock(BytesN<32>),
    /// Address of the Governance contract used to gate
    /// `inject_emergency_liquidity`.  Absent until `set_governance_contract`
    /// is called by the admin.
    GovernanceContract,
    /// Lifetime amount injected into the pool via `inject_emergency_liquidity`.
    /// Tracked separately so it can be reconciled and repaid to the insurance
    /// reserve as the pool recovers.
    TotalEmergencyInjected,
    /// Keeper reward rate, in basis points of the collateral seized when a
    /// third party triggers `trigger_default`. Absent or zero disables the
    /// reward.
    KeeperRewardBps,
    /// Absolute ceiling, in token stroops, on a single keeper reward.
    KeeperRewardCap,
    /// Aggregate principal of a borrower's approved, not-yet-closed loans.
    /// Counted from `approve_loan` and released on full repayment, default
    /// or assumption by another borrower. Absent means zero.
    BorrowerExposure(Address),
    /// Absolute ceiling on a borrower's aggregate exposure, in token stroops.
    /// Absent or zero disables the absolute cap.
    MaxBorrowerExposure,
    /// Ceiling on a borrower's aggregate exposure as basis points of the
    /// pool's total tranche capital. Absent or zero disables the relative cap.
    MaxBorrowerExposureBps,
    /// Independent pause flag for one function group, alongside the global
    /// pause. Absent means unpaused, so existing deployments are unaffected.
    FunctionPaused(PauseGroup),
    /// Revolving credit line keyed by borrower address.
    CreditLine(Address),
    /// Lockup-tier position for an investor.
    InvestorLockup(Address),
    /// Accumulated funds reserved to pay lockup bonuses.
    LockupBonusPool,
    /// Share (bps) of the protocol fee routed to the lockup bonus pool.
    LockupBonusFeeShareBps,
    /// Number of extensions already granted to a loan.
    LoanExtensionCount(BytesN<32>),
    /// Maximum number of extensions a single loan may receive.
    MaxExtensionsPerLoan,
    /// Maximum term, in months, of a single loan extension.
    MaxExtensionMonths,
    /// Extension fee, in basis points.
    ExtensionFeeBps,
    /// Interest-only intro configuration for a loan.
    LoanInterestOnly(BytesN<32>),
    /// Maximum permitted interest-only intro period, in months.
    MaxInterestOnlyMonths,
    /// Admin-set maximum total deposits for a tranche, in token stroops.
    /// Absent or zero means uncapped.
    TrancheDepositCap(Tranche),
    /// Admin-set maximum position size of a single investor, in token
    /// stroops. Absent or zero means uncapped.
    InvestorDepositCap,
    /// Pending timelocked change to a tranche's deposit cap.
    PendingTrancheCap(Tranche),
    /// Pending timelocked change to the per-investor deposit cap.
    PendingInvestorCap,
    /// Ledgers that must elapse between proposing and executing a deposit
    /// cap change. Absent means `DEFAULT_CAP_CHANGE_DELAY_LEDGERS`.
    DepositCapChangeDelay,
    /// Ceiling on late fees per billing period, as an absolute amount in
    /// token stroops. Absent or zero disables this limb of the cap.
    LateFeeCapAbs,
    /// Ceiling on late fees per billing period, in basis points of the
    /// installment. Absent or zero disables this limb of the cap.
    LateFeeCapBps,
    /// Fee charged to the incoming borrower on `assume_loan`, in basis points
    /// of the loan's outstanding principal. Absent or zero means no fee.
    /// Never above `MAX_ASSUMPTION_FEE_BPS`.
    AssumptionFeeBps,
    /// An investor's yield mode. Absent means `YieldMode::Claim`.
    YieldMode(Address),
    /// Configured collateral haircut (bps) for an asset class. Absent means
    /// no haircut (0 bps) — face value counts in full toward ratio checks.
    AssetClassHaircut(Symbol),
    /// Pending timelocked haircut change for an asset class.
    PendingHaircutChange(Symbol),
    /// Ledgers that must elapse between proposing and executing a haircut
    /// change. `0` disables the timelock (changes apply immediately).
    HaircutChangeDelay,
    /// The pool's wind-down lifecycle state. Absent means `Active`.
    WindDownStatus,
    /// Pending timelocked wind-down start.
    PendingWindDown,
    /// Ledgers that must elapse between proposing and executing wind-down.
    /// `0` disables the timelock (wind-down starts immediately).
    WindDownDelay,
}

/// Function groups that can be paused independently of the global pause.
#[contracttype]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PauseGroup {
    /// `deposit` / `deposit_with_cap`.
    Deposits,
    /// `withdraw`.
    Withdrawals,
    /// `request_loan` / `request_loan_with_origin`.
    LoanRequests,
    /// `repay` / `payoff_with_quote`. Pausable only on its own, so a problem
    /// elsewhere never has to stop borrowers paying down their loans.
    Repayments,
}

/// A pending loan assumption request where an existing borrower proposes to transfer
/// their loan obligations to a new borrower.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanAssumptionRequest {
    /// Address of the current borrower requesting assumption.
    pub current_borrower: Address,
    /// Address of the proposed new borrower assuming the loan.
    pub proposed_borrower: Address,
    /// Ledger sequence when the assumption request was initiated.
    pub requested_at_ledger: u32,
}

/// Tracks collateral amounts, releases, and minimum collateralization ratio for a loan.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanCollateralRecord {
    /// Initial locked collateral amount, at face value.
    pub initial_collateral: i128,
    /// Total collateral amount released to borrower so far, at face value.
    pub released_collateral: i128,
    /// Minimum required collateralization ratio in basis points (e.g. 3000 = 30%),
    /// checked against the haircut-adjusted (not face) value of the remaining
    /// collateral.
    pub min_collateral_ratio_bps: u32,
    /// The collateral's asset class, used to look up its configured haircut
    /// (`FeatureKey::AssetClassHaircut`) when computing collateralization ratios.
    /// Does not affect the face-value amounts above — only how much of that
    /// face value counts toward meeting `min_collateral_ratio_bps`.
    pub asset_class: Symbol,
}

/// A locked payoff quote: the exact amount that settles the loan if paid
/// within the validity window, regardless of intervening interest accrual.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PayoffQuote {
    /// Snapshotted payoff amount (outstanding debt at quote time).
    pub quoted_amount: i128,
    /// Ledger at which the quote was created.
    pub quoted_at_ledger: u32,
    /// Last ledger at which the quote is still valid (inclusive).
    pub expires_ledger: u32,
}

/// A revolving credit line secured against a borrower's escrow position,
/// similar to a HELOC: once approved, the borrower may draw and repay
/// repeatedly up to `approved_limit` without re-applying for a new loan.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CreditLine {
    /// The borrower's address.
    pub borrower: Address,
    /// Maximum balance the borrower may have drawn at any one time.
    pub approved_limit: i128,
    /// Currently drawn (outstanding) balance, including accrued interest.
    pub drawn_balance: i128,
    /// Annual interest rate in basis points, charged only on `drawn_balance`.
    pub interest_rate_bps: u32,
    /// Ledger when the credit line was opened.
    pub opened_ledger: u32,
    /// Ledger sequence when interest was last accrued on `drawn_balance`.
    pub last_interest_ledger: u32,
}

/// Lockup tiers for investors with commitment duration and bonus yield.
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LockupTier {
    /// No commitment: standard liquidity, 0 bps bonus yield.
    None = 0,
    /// 90-day lockup commitment with 100 bps (1.0%) bonus yield.
    Tier90Days = 1,
    /// 180-day lockup commitment with 250 bps (2.5%) bonus yield.
    Tier180Days = 2,
    /// 365-day lockup commitment with 500 bps (5.0%) bonus yield.
    Tier365Days = 3,
}

impl LockupTier {
    pub fn days(&self) -> u32 {
        match self {
            LockupTier::None => 0,
            LockupTier::Tier90Days => 90,
            LockupTier::Tier180Days => 180,
            LockupTier::Tier365Days => 365,
        }
    }

    pub fn bonus_bps(&self) -> u32 {
        match self {
            LockupTier::None => 0,
            LockupTier::Tier90Days => 100,
            LockupTier::Tier180Days => 250,
            LockupTier::Tier365Days => 500,
        }
    }
}

/// Tracks an investor's lockup tier position.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvestorLockupPosition {
    pub tier: LockupTier,
    pub unlock_ledger: u32,
    pub bonus_bps: u32,
    /// Ledger from which bonus accrual is measured. Set once when the
    /// position first adopts a non-`None` tier, and never reset by a
    /// top-up — a top-up extends `unlock_ledger` (never shortens it) and
    /// may raise `bonus_bps` if the new tier pays more, but accrual keeps
    /// counting from the original commitment.
    pub bonus_start_ledger: u32,
    /// Total bonus already paid out via `claim_lockup_bonus`. Pending bonus
    /// is always computed as total accrued minus this.
    pub claimed_bonus: i128,
}

/// Lifecycle phase of a loan (interest-only vs amortizing).
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum LoanPhase {
    /// Principal amortizes with each payment.
    Amortizing = 0,
    /// Payments cover accrued interest only; principal remains unchanged.
    InterestOnly = 1,
}

/// Intro interest-only configuration stored per loan.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanIntroConfig {
    pub interest_only_months: u32,
    pub phase: LoanPhase,
}

/// Detailed schedule view including loan repayment phase.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ScheduleView {
    pub monthly_amount: i128,
    pub duration_months: u32,
    pub next_due_ledger: u32,
    pub payments_made: u32,
    pub payments_missed: u32,
    pub interest_only_months: u32,
    pub phase: LoanPhase,
}
