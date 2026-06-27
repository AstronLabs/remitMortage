use soroban_sdk::{contracttype, Address, BytesN, Symbol};

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
}

/// Tracks an individual borrower's escrow balance and status per goal.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BorrowerRecord {
    /// Total deposited amount (USDC stroops).
    pub deposited: i128,
    /// Ledger sequence when the borrower first deposited.
    pub start_ledger: u32,
    /// Whether the borrower has completed their savings target and funds were released.
    pub released: bool,
    /// Whether the borrower withdrew early.
    pub withdrawn: bool,
    /// Whether the collateral was seized by the lending pool due to default.
    pub seized: bool,
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
    /// Current contract version (incremented on each upgrade).
    Version,
    /// Pending upgrade proposal (present only when a timelock delay is active).
    PendingUpgrade,
    /// Number of ledgers the admin must wait between proposing and executing an upgrade.
    UpgradeDelay,
    /// Emergency pause flag. When true, deposits and withdrawals are blocked.
    Paused,
    /// Pending new admin address for two-step admin transfer.
    PendingAdmin,
}
