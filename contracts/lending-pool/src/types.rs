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
    /// When true, only whitelisted addresses may call deposit, request_loan,
    /// and withdraw. Toggleable by admin for regulated or pilot deployments.
    /// `false` — the deployment default — preserves existing permissionless
    /// behaviour.
    pub permissioned_mode: bool,
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

/// An individual item in a batch disbursement request.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BatchDisburseItem {
    pub loan_id: BytesN<32>,
    pub recipient: Address,
    pub amount: i128,
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
    /// Initial locked collateral amount.
    pub initial_collateral: i128,
    /// Total collateral amount released to borrower so far.
    pub released_collateral: i128,
    /// Minimum required collateralization ratio in basis points (e.g. 3000 = 30%).
    pub min_collateral_ratio_bps: u32,
}
