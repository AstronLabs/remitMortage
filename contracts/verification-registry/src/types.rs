// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, BytesN};

/// Borrower risk tiers updated from repayment history.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum RiskTier {
    Excellent = 0,
    Good = 1,
    Fair = 2,
    Poor = 3,
}

/// On-chain anchor for a borrower eligibility verification report.
///
/// The sensitive financial dataset itself is kept off-chain; only the
/// cryptographic hash of the report is stored here for auditability.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct VerificationRecord {
    /// The borrower the verification report belongs to.
    pub borrower: Address,
    /// Cryptographic hash of the off-chain verification report.
    pub report_hash: BytesN<32>,
    /// Ledger sequence at which the verification was registered.
    pub verified_ledger: u32,
    /// Ledger sequence of the most recent (re-)verification. This is the
    /// anchor the score decay is measured from, so re-verifying resets the
    /// decay timer without disturbing the original `verified_ledger`.
    pub last_verified_ledger: u32,
    /// Ledger sequence after which the verification is considered expired.
    pub expiration_ledger: u32,
    /// Anchored credit score (0–100) from the off-chain verification report.
    pub score: u32,
}

/// Interest rate configuration for dynamic rate calculation.
///
/// Allows the protocol to update interest rates globally without
/// redeploying contracts, adapting to macroeconomic conditions.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RateConfig {
    /// Interest rate for excellent tier (score 80-100) in basis points.
    pub rate_excellent_bps: u32,
    /// Interest rate for good tier (score 60-79) in basis points.
    pub rate_good_bps: u32,
    /// Interest rate for fair tier (score 40-59) in basis points.
    pub rate_fair_bps: u32,
    /// Fallback rate when verification is missing/expired, in basis points.
    pub rate_fallback_bps: u32,
}

/// Parameters controlling how an inactive borrower's score decays.
///
/// A borrower keeps their full score for `threshold_ledgers` after their last
/// verification. Past that, the score falls linearly — `points_per_period`
/// points for every `period_ledgers` of continued inactivity — but never
/// below `min_score`.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DecayConfig {
    /// Inactivity allowed before any decay applies (the grace window).
    pub threshold_ledgers: u32,
    /// Score points shed per decay period once past the threshold.
    pub points_per_period: u32,
    /// Length of one decay period, in ledgers.
    pub period_ledgers: u32,
    /// Lower bound decay can never push a score below.
    pub min_score: u32,
}

/// Dynamic borrower risk profile derived from repayment callbacks.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RiskRecord {
    /// Current score, 0-100.
    pub score: u32,
    /// Current tier derived from the score.
    pub tier: RiskTier,
    /// Consecutive late repayments.
    pub consecutive_late: u32,
    /// Total on-time repayments.
    pub on_time_payments: u32,
    /// Total late repayments.
    pub late_payments: u32,
}

/// Storage keys for the verification registry contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract admin address.
    Admin,
    /// Pending admin address awaiting acceptance of the admin role.
    ProposedAdmin,
    /// Verification record keyed by borrower address.
    Verification(Address),
    /// Dynamic interest rate configuration.
    RateConfig,
    /// Lending pool address allowed to push repayment callbacks.
    LendingPool,
    /// Dynamic borrower risk profile keyed by borrower address.
    Risk(Address),
    /// Maximum allowable interest rate in basis points (cap).
    RateCap,
    /// Minimum allowable interest rate in basis points (floor).
    RateFloor,
    /// Score decay parameters. Absent until `set_decay_config` is called, in
    /// which case the protocol defaults apply.
    DecayConfig,
}
