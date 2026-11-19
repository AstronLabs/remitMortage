// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

/// Admin-controlled signer set used for death/incapacity attestations.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BeneficiaryAttestorConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
}

/// One entry in a multi-beneficiary split list.
///
/// `share_bps` is this recipient's entitlement expressed in basis points
/// (1 bp = 0.01 %).  All entries in a `BeneficiaryList` must sum to exactly
/// 10 000 bps (= 100 %).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BeneficiarySplit {
    /// The receiving address.
    pub beneficiary: Address,
    /// Share of the total claimable amount in basis points (0 < share_bps ≤ 10_000).
    pub share_bps: u32,
}

/// Ordered list of beneficiary splits stored per (owner, goal_id).
///
/// The sum of all `share_bps` values MUST equal 10 000 at the time the list
/// is persisted; the contract rejects any configuration that violates this.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BeneficiaryList {
    pub splits: Vec<BeneficiarySplit>,
}

/// Configuration set during contract initialization.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct EscrowConfig {
    /// Admin address that can release funds or update config.
    pub admin: Address,
    /// USDC token contract address on Stellar.
    pub token: Address,
    /// Lending pool contract address linked to this escrow.
    pub lending_pool: Address,
    /// Savings target amount in USDC (in stroops, i.e. 7 decimals).
    pub savings_target: i128,
    /// Maximum savings period in ledger-sequence increments.
    pub max_duration_ledgers: u32,
    /// Early withdrawal penalty as basis points (e.g. 500 = 5%).
    pub early_withdrawal_penalty_bps: u32,
    /// Minimum savings duration in ledgers that must elapse before release is
    /// permitted (e.g. 518_400 ≈ 6 months at 5-second ledger time).
    /// A value of 0 disables the lockup check.
    pub min_duration_ledgers: u32,
    /// Tier 1 penalty (months 1-2) in basis points (e.g. 500 = 5%).
    pub penalty_bps_tier1: u32,
    /// Tier 2 penalty (months 3-4) in basis points.
    pub penalty_bps_tier2: u32,
    /// Tier 3 penalty (months 5-6) in basis points.
    pub penalty_bps_tier3: u32,
    /// Tier 4 penalty (month 7+) in basis points.
    pub penalty_bps_tier4: u32,
    /// Ledgers after a missed monthly contribution before default removal is allowed (~120,960 ≈ 7 days).
    pub grace_period_ledgers: u32,
    /// Penalty applied on forced default removal, in basis points.
    pub default_penalty_bps: u32,
    /// Ledgers added to the instance TTL on every state-changing call.
    /// Set per network (Testnet vs Pubnet) at initialization.
    pub instance_bump_amount: u32,
    /// Remaining instance TTL that triggers a bump. The bump is skipped while
    /// the entry still has more than this many ledgers left.
    pub instance_lifetime_threshold: u32,
    /// Ledgers added to a persistent entry's TTL when it is written.
    pub persistent_bump_amount: u32,
    /// Remaining persistent TTL that triggers a bump.
    pub persistent_lifetime_threshold: u32,
    /// Optional lending protocol vault address for yield routing.
    pub yield_vault: Option<Address>,
    /// Percentage of a first-cycle deposit matched from the dedicated reserve.
    pub match_bps: u32,
    /// Maximum matched amount per first-cycle goal, in token units.
    pub match_cap: i128,
    /// When true, only whitelisted addresses may deposit. Toggleable by admin
    /// for regulated or pilot deployments. `false` — the deployment default —
    /// preserves existing permissionless behaviour.
    pub permissioned_mode: bool,
}

/// Tracks an individual borrower's escrow balance and status per goal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BorrowerRecord {
    /// Total deposited amount (USDC stroops).
    pub deposited: i128,
    /// Ledger sequence when the borrower first deposited.
    pub start_ledger: u32,
    /// Ledger sequence of the latest contribution.
    pub last_contribution_ledger: u32,
    /// Whether the borrower has completed their savings target and funds were released.
    pub released: bool,
    /// Whether the borrower withdrew early.
    pub withdrawn: bool,
    /// Whether the collateral was seized by the lending pool due to default.
    pub seized: bool,
    /// Yield shares allocated from yield vault routing.
    pub yield_shares: i128,
    /// Total reserve amount matched during the current savings cycle.
    pub matched_amount: i128,
    /// Configurable opt-in flag to automatically roll over matured balance into a new savings cycle.
    pub auto_rollover: bool,
}

/// Borrower-authorized recurring deposit schedule for one escrow goal.
///
/// Anyone (e.g. a keeper bot) may execute the draw once `next_execution_ledger`
/// is reached; funds are pulled from the borrower's pre-approved allowance.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AutoDepositSchedule {
    /// Amount pulled per draw (USDC stroops).
    pub amount: i128,
    /// Ledgers between draws.
    pub interval_ledgers: u32,
    /// Earliest ledger at which the next draw may execute.
    pub next_execution_ledger: u32,
}

/// Pending upgrade proposal data.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpgradeRecord {
    pub new_wasm_hash: BytesN<32>,
    pub execute_after: u32,
}

/// Pending penalty tier proposal data.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingPenaltyProposal {
    pub tier1: u32,
    pub tier2: u32,
    pub tier3: u32,
    pub tier4: u32,
    pub execute_after: u32,
}

/// Pending beneficiary-attestor signer/threshold change, awaiting its
/// timelock before `apply_attestor_change` may activate it.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingAttestorChangeProposal {
    pub signers: Vec<Address>,
    pub threshold: u32,
    pub execute_after: u32,
}

/// One borrower/goal record named in a permissionless TTL-extension batch
/// (issue #855). The keeper entry point only accepts records this contract
/// owns, so callers name them by the same `(borrower, goal_id)` tuple used for
/// `DataKey::Borrower`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TtlKeeperEntry {
    pub borrower: Address,
    pub goal_id: Symbol,
}

/// Storage keys for the escrow contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Stores the EscrowConfig. Only one per contract instance.
    Config,
    /// Stores a BorrowerRecord keyed by the borrower's address and goal ID.
    Borrower(Address, Symbol),
    /// Total pooled balance across all borrowers.
    TotalPooled,
    /// Remaining token-denominated balance available for deposit matching.
    MatchingReserve,
    /// Total yield shares issued.
    TotalYieldShares,
    /// Current contract version (incremented on each upgrade).
    Version,
    /// Pending upgrade proposal (present only when a timelock delay is active).
    PendingUpgrade,
    /// Pending penalty tier proposal (present only when a timelock delay is active).
    PendingPenaltyTiers,
    /// Number of ledgers the admin must wait between proposing and executing an upgrade.
    UpgradeDelay,
    /// Emergency pause flag. When true, deposits and withdrawals are blocked.
    Paused,
    /// Pending new admin address for two-step admin transfer.
    PendingAdmin,
    /// Optional LendingPool contract address that early-exit penalty fees are
    /// routed to as investor yield. Unset means penalties stay in the contract.
    LendingPool,
    /// Beneficiary designated by the borrower for a given goal.
    Beneficiary(Address, Symbol),
    /// Multi-beneficiary split list designated by the borrower for a given goal.
    /// When present it takes precedence over the legacy single `Beneficiary` key.
    BeneficiaryList(Address, Symbol),
    /// Last ledger at which the goal owner performed an authenticated action.
    LastOwnerActivity(Address, Symbol),
    /// Marks that a beneficiary has already claimed a given goal.
    BeneficiaryClaimed(Address, Symbol),
    /// Ledgers of owner inactivity after which a beneficiary may claim.
    BeneficiaryInactivityPeriod,
    /// Admin-controlled signer set used for death/incapacity attestations.
    BeneficiaryAttestors,
    /// Yield shares allocated to a borrower for a given goal.
    YieldShares(Address, Symbol),
    /// Reentrancy guard flag.
    ReentrancyGuard,
    /// Whitelist flag for a permissioned-mode address. Present and `true` means
    /// the address is allowed to interact with the contract when permissioned
    /// mode is enabled.
    Whitelist(Address),
    /// Recurring auto-deposit schedule for a borrower's goal.
    AutoDeposit(Address, Symbol),
    /// Pending beneficiary-attestor signer/threshold change (present only
    /// while a change is awaiting its timelock).
    PendingAttestorChange,
    /// Ledgers the admin must wait between proposing and applying a
    /// beneficiary-attestor signer/threshold change. `0` — the deployment
    /// default — applies changes immediately, preserving existing behavior.
    AttestorChangeDelay,
    /// Pending or resolved hardship withdrawal request, keyed by borrower and goal.
    HardshipRequest(Address, Symbol),
    /// Ledgers after a hardship request within which the admin must approve
    /// it, or it expires. `0` falls back to `DEFAULT_HARDSHIP_WINDOW_LEDGERS`.
    HardshipApprovalWindowLedgers,
    /// Maximum cumulative principal (not accrued yield) a single
    /// borrower/goal may withdraw penalty-free via hardship withdrawal
    /// within one `HardshipPeriodLedgers` window. `0` disables the cap.
    HardshipCapPerPeriod,
    /// Length, in ledgers, of one hardship-withdrawal cap period.
    HardshipPeriodLedgers,
    /// Cumulative hardship principal withdrawn by a borrower/goal within a
    /// specific period index (`current_ledger / HardshipPeriodLedgers`).
    HardshipWithdrawnInPeriod(Address, Symbol, u32),
    /// Admin-confirmed scheduled release time for a borrower's goal.
    ReleaseSchedule(Address, Symbol),
    /// Release time proposed by the borrower, awaiting admin confirmation.
    PendingReleaseTime(Address, Symbol),
    /// Limits on how often and how far a release time can be rescheduled.
    ReleaseScheduleLimits,
}

/// An admin-confirmed release date for one escrow goal. While present,
/// `release` reverts before `release_time` even if the savings target is met.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseSchedule {
    /// Ledger timestamp (seconds) from which release is allowed.
    pub release_time: u64,
    /// How many times the confirmed date has been moved after the first
    /// confirmation.
    pub reschedule_count: u32,
    /// Ledger timestamp at which the date was last confirmed.
    pub confirmed_at: u64,
}

/// Limits on rescheduling a goal's release time. `0` means unlimited for the
/// interval, horizon and shift fields; `max_reschedules == 0` forbids any
/// rescheduling once a date has been confirmed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReleaseScheduleLimits {
    /// Maximum number of reschedules after the first confirmation.
    pub max_reschedules: u32,
    /// Minimum seconds between two confirmed changes of the date.
    pub min_reschedule_interval_secs: u64,
    /// Furthest a release time may lie in the future, in seconds from now.
    pub max_horizon_secs: u64,
    /// Largest move, in seconds, between the current confirmed date and a
    /// rescheduled one.
    pub max_shift_secs: u64,
}

/// A borrower's hardship withdrawal request: a hash of the supporting
/// reason/document (never the document itself), awaiting admin approval
/// within a configurable window before it can be executed penalty-free.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct HardshipWithdrawalRequest {
    pub reason_hash: BytesN<32>,
    pub requested_at_ledger: u32,
    pub approved: bool,
    pub approver: Option<Address>,
}
