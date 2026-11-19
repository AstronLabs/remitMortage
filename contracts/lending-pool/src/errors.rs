// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    // Soroban caps a contract error enum at 50 variants. Discriminants 11, 15,
    // 18, 19 and 27-31 belonged to variants nothing returned and are retired;
    // don't reuse them.
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract has not been initialized yet.
    NotInitialized = 2,
    /// Amount must be greater than zero.
    InvalidAmount = 3,
    /// Only the admin can perform this action.
    Unauthorized = 4,
    /// Investor has insufficient balance to withdraw.
    InsufficientBalance = 5,
    /// Loan with this ID already exists.
    LoanAlreadyExists = 6,
    /// Loan not found.
    LoanNotFound = 7,
    /// Loan is not in the correct state for this operation.
    InvalidLoanState = 8,
    /// Insufficient pool liquidity for the requested disbursement.
    InsufficientLiquidity = 9,
    /// Repayment exceeds remaining loan balance.
    OverPayment = 10,
    /// Operation rejected because the contract is paused.
    ContractPaused = 13,
    /// Proposed new admin is not the caller or no transfer is pending.
    NotPendingAdmin = 14,
    /// A timelocked change (upgrade, haircut, deposit cap, ...) was proposed but its delay has not elapsed yet.
    TimelockActive = 16,
    /// Investor cannot change tranche after the initial deposit.
    TrancheMismatch = 17,
    /// The daily borrow limit has been exceeded.
    DailyBorrowLimitExceeded = 20,
    /// Refund amount exceeds the amount disbursed for the loan.
    RefundExceedsDisbursed = 21,
    /// Disbursement recipient is not a whitelisted contractor.
    UnauthorizedContractor = 22,
    /// Refinancing requires at least 3 successful payments.
    InsufficientPaymentHistory = 23,
    /// Interest rate for refinancing is below the allowed floor.
    InterestRateTooLow = 24,
    /// Loan cannot be refinanced.
    RefinanceNotEligible = 25,
    /// Loan is not yet overdue, so it cannot be marked as defaulted.
    LoanNotOverdue = 26,
    /// Loan maturity rebate has already been claimed.
    RebateAlreadyClaimed = 32,
    /// Loan has missed payments, so is ineligible for the maturity rebate or an extension.
    LoanNotGoodStanding = 33,
    /// Loan must be in Approved state for this operation.
    LoanNotActive = 37,
    /// A restructure proposal already exists for this loan.
    RestructureProposalExists = 38,
    /// No pending restructure proposal for this loan.
    NoRestructureProposal = 34,
    /// MultisigValidator contract address has not been configured.
    MultisigValidatorNotSet = 35,
    /// Investor withdrawal is blocked because the lockup period has not elapsed.
    LockupPeriodActive = 36,
    /// Deposit is below the pool's configured minimum deposit amount.
    DepositBelowMinimum = 40,
    /// Collateral release would breach the minimum collateralization ratio.
    CollateralRatioBreached = 41,
    /// No collateral available for release.
    NoCollateralToRelease = 42,
    /// Invalid collateral ratio configuration.
    InvalidCollateralRatio = 44,
    /// A fee (origination, application or protocol fee switch) exceeds its ceiling.
    FeeTooHigh = 45,
    /// Borrower already holds the maximum number of active loans permitted by
    /// `max_active_loans_per_borrower`, or the loan would push their aggregate
    /// outstanding principal past the configured exposure cap. (The error enum
    /// is at Soroban's 50-variant ceiling, so both limits share this code.)
    BorrowerLoanCapExceeded = 46,
    /// Refinancing request was submitted before the cooldown window elapsed.
    RefinanceCooldownActive = 47,
    /// Withdrawal amount exceeds the pool's configured per-transaction limit.
    WithdrawalExceedsMaxSingleLimit = 50,
    /// No payoff quote exists for this loan.
    PayoffQuoteNotFound = 51,
    /// The payoff quote has expired; request a fresh quote.
    PayoffQuoteExpired = 52,
    /// Deposit attempted before the configured per-investor cooldown has elapsed.
    DepositCooldownActive = 54,
    /// Refinance execution attempted after the rate-lock window has expired.
    /// The borrower must call `request_refinance` again to obtain a fresh quote.
    RefinanceRateLockExpired = 55,
    /// Emergency liquidity injection requires an InsurancePool to be configured.
    InsurancePoolNotSet = 57,
    /// Emergency liquidity injection requires a GovernanceContract to be configured.
    GovernanceContractNotSet = 58,
    /// The referenced governance proposal has not reached `Passed` status.
    GovernanceProposalNotPassed = 59,
    /// Injection amount exceeds the configured percentage cap of insurance reserves.
    EmergencyInjectionCapExceeded = 60,
    /// A credit line already exists for this borrower.
    CreditLineAlreadyExists = 61,
    /// No credit line exists for this borrower.
    CreditLineNotFound = 62,
    /// Draw would exceed the approved credit limit minus the outstanding
    /// drawn balance.
    CreditLimitExceeded = 63,
    /// Loan extension exceeds the permitted count or term.
    ExtensionCapExceeded = 64,
    /// Deposit would push the tranche's total past its admin-set cap.
    TrancheCapExceeded = 65,
    /// Deposit would push the investor's position past the admin-set
    /// per-investor cap.
    InvestorCapExceeded = 66,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum LoanAssumptionError {
    ContractPaused = 1,
    LoanNotFound = 2,
    LoanNotActive = 3,
    AssumptionNotAuthorized = 4,
    ApplicantNotVerified = 5,
    AssumptionNotFound = 6,
    AssumptionAlreadyRequested = 7,
    /// The requested loan assumption fee is above the hard on-chain cap.
    AssumptionFeeCapExceeded = 8,
    /// The pool has not been initialized.
    NotInitialized = 9,
}
