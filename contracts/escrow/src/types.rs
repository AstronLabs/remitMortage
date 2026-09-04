use soroban_sdk::{contracttype, Address, BytesN, Symbol, Vec};

/// Admin-controlled signer set used for death/incapacity attestations.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BeneficiaryAttestorConfig {
    pub signers: Vec<Address>,
    pub threshold: u32,
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
    /// Configurable opt-in flag to automatically roll over matured balance into a new savings cycle.
    pub auto_rollover: bool,
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
    /// Reentrancy guard flag.
    ReentrancyGuard,
    /// Whitelist flag for a permissioned-mode address. Present and `true` means
    /// the address is allowed to interact with the contract when permissioned
    /// mode is enabled.
    Whitelist(Address),
}
