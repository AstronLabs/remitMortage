use soroban_sdk::{contracttype, Address};

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
    /// Tier 1 penalty (months 1-2) in basis points (e.g. 500 = 5%).
    pub penalty_bps_tier1: u32,
    /// Tier 2 penalty (months 3-4) in basis points.
    pub penalty_bps_tier2: u32,
    /// Tier 3 penalty (months 5-6) in basis points.
    pub penalty_bps_tier3: u32,
    /// Tier 4 penalty (month 7+) in basis points.
    pub penalty_bps_tier4: u32,
}

/// Tracks an individual borrower's escrow balance and status.
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
    /// Stores a BorrowerRecord keyed by the borrower's address.
    Borrower(Address),
    /// Total pooled balance across all borrowers.
    TotalPooled,
}
