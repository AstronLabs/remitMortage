// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::contracterror;

/// Errors returned by the multisig validator contract.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ValidatorError {
    /// No signer configuration exists for the requested account.
    AccountNotConfigured = 1,
    /// A configuration already exists for the account.
    AccountAlreadyConfigured = 2,
    /// Threshold must be > 0 and <= the total configurable signer weight.
    InvalidThreshold = 3,
    /// A signer weight of zero is not allowed.
    InvalidWeight = 4,
    /// The signer set contains a duplicate key.
    DuplicateSigner = 5,
    /// A presented signer is not part of the account's configured signer set.
    UnknownSigner = 6,
    /// The cumulative weight of the presented signers is below the threshold.
    InsufficientWeight = 7,
    /// The signer set is empty.
    NoSigners = 8,
    /// No proposal exists for the given ID.
    ProposalNotFound = 9,
    /// The proposal has already been executed.
    ProposalAlreadyExecuted = 10,
    /// The timelock delay has not yet elapsed.
    TimelockNotElapsed = 11,
    /// No timelock has been configured for this account.
    TimelockNotConfigured = 12,
    /// The approval period has not yet been reached.
    NotYetApproved = 13,
    /// No admin has been initialized for the admin-managed signer set.
    AdminNotSet = 14,
    /// An admin has already been initialized.
    AdminAlreadySet = 15,
    /// The address is already a configured admin-managed signer.
    SignerAlreadyExists = 16,
    /// The address is not a configured admin-managed signer.
    SignerNotFound = 17,
    /// The admin-managed signer set has not been configured.
    AdminConfigNotSet = 18,
    /// The proposal has expired (current ledger past expiration_ledger).
    ProposalExpired = 19,
    /// Signer is penalized for repeated missed votes (weight reduced).
    SignerPenalized = 20,
}
