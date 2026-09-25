// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum EscrowError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract has not been initialized yet.
    NotInitialized = 2,
    /// Deposit amount must be greater than zero.
    InvalidAmount = 3,
    /// Borrower has already completed their savings and funds were released.
    AlreadyReleased = 4,
    /// Borrower has already withdrawn.
    AlreadyWithdrawn = 5,
    /// Savings target has not been reached yet.
    TargetNotReached = 6,
    /// Only the admin can call this function.
    Unauthorized = 7,
    /// The savings period has expired.
    PeriodExpired = 8,
    /// Borrower record not found.
    BorrowerNotFound = 9,
    /// Collateral has already been seized.
    AlreadySeized = 10,
    /// No pending upgrade exists to execute.
    UpgradeNotPending = 11,
    /// Upgrade was proposed but the timelock delay has not elapsed yet.
    UpgradeTimelockActive = 12,
    /// The borrower's grace period has not yet expired; removal is not allowed.
    GracePeriodActive = 13,
    /// The borrower is not in default and cannot be forcibly removed.
    BorrowerNotInDefault = 14,
    /// Minimum savings lockup period has not elapsed yet.
    LockupNotMet = 18,
    /// Operation rejected because the contract is paused.
    ContractPaused = 15,
    /// Proposed new admin is not the caller or no transfer is pending.
    NotPendingAdmin = 16,
    /// Cross-contract bridge call to the lending pool failed.
    BridgeFailed = 17,
    /// Penalty tier values must be within basis-points bounds.
    InvalidPenaltyBps = 19,
    /// Reentrant call detected — mutating function already in progress.
    ReentrancyGuard = 20,
    /// TTL bump amounts and lifetime thresholds must be greater than zero.
    InvalidTtlConfig = 21,
    /// Penalty proposal is not pending.
    PenaltyProposalNotPending = 22,
    /// Escrow goal does not exist or has no deposits.
    EscrowGoalNotFound = 23,
    /// Address is not whitelisted when permissioned mode is enabled.
    AddressNotWhitelisted = 24,
    /// No auto-deposit schedule is configured for this borrower/goal escrow.
    AutoDepositNotConfigured = 34,
    /// The auto-deposit interval has not elapsed since the last scheduled draw.
    AutoDepositNotDue = 35,
    /// The borrower's token allowance to the escrow is below the scheduled amount.
    InsufficientAllowance = 36,
    /// The borrower's token balance is below the scheduled amount.
    InsufficientBalance = 37,
    /// Auto-deposit interval must be greater than zero ledgers.
    InvalidAutoDepositInterval = 38,
}
