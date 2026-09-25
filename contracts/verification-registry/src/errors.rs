// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract has not been initialized yet.
    NotInitialized = 2,
    /// Caller is not authorized to perform the action.
    Unauthorized = 3,
    /// Verification duration must be greater than zero.
    InvalidDuration = 4,
    /// Report hash must not be empty/zeroed.
    InvalidHash = 5,
    /// No verification record found for the borrower.
    VerificationNotFound = 6,
    /// No pending admin proposal exists to accept.
    NoProposedAdmin = 7,
    /// Score must be in the range 0–100 inclusive.
    InvalidScore = 8,
    /// Repayment callback may only be pushed by the configured lending pool.
    UnauthorizedPool = 9,
    /// Referral or risk state update would create an invalid cycle.
    InvalidRiskTransition = 10,
    /// Rate cap/floor values are invalid (floor > cap or cap > 10000).
    InvalidRateLimits = 11,
    /// Decay parameters are invalid (zero period, or scores out of range).
    InvalidDecayConfig = 12,
}
