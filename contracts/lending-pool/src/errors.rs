use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
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
    /// Loan has not met the criteria for default.
    NotEligibleForDefault = 11,
    /// Loan has already defaulted.
    AlreadyDefaulted = 12,
    /// Operation rejected because the contract is paused.
    ContractPaused = 13,
    /// Proposed new admin is not the caller or no transfer is pending.
    NotPendingAdmin = 14,
    /// No pending upgrade exists to execute.
    UpgradeNotPending = 15,
    /// Upgrade was proposed but the timelock delay has not elapsed yet.
    UpgradeTimelockActive = 16,
    /// Investor cannot change tranche after the initial deposit.
    TrancheMismatch = 17,
    /// Junior tranche has insufficient capital to absorb this loss.
    InsufficientJuniorCapital = 18,
    /// Borrower has no valid, non-expired verification record in the
    /// configured VerificationRegistry, so the loan request is rejected.
    ApplicantNotVerified = 19,
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
    /// Oracle data is stale or unavailable.
    OracleUnavailable = 27,
    /// Oracle price is zero or invalid.
    OraclePriceInvalid = 28,
    /// Requested loan exceeds the configured maximum LTV.
    LtvExceeded = 29,
    /// Referral relationships cannot contain cycles.
    ReferralCycleDetected = 30,
    /// Referral relationship already exists.
    ReferralAlreadySet = 31,
    /// Loan maturity rebate has already been claimed.
    RebateAlreadyClaimed = 32,
    /// Loan has missed payments, so is ineligible for the maturity rebate.
    MissedPaymentsPreventRebate = 33,
    /// Loan must be in Approved state for this operation.
    LoanNotActive = 37,
    /// A restructure proposal already exists for this loan.
    RestructureProposalExists = 38,
    /// Proposed fee switch exceeds the hard protocol cap.
    FeeSwitchTooHigh = 39,
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
    /// Collateral has already been seized.
    CollateralAlreadySeized = 43,
    /// Invalid collateral ratio configuration.
    InvalidCollateralRatio = 44,
    /// Origination fee exceeds the full-disbursement ceiling.
    OriginationFeeTooHigh = 45,
    /// Borrower already holds the maximum number of active loans permitted by
    /// `max_active_loans_per_borrower`.
    BorrowerLoanCapExceeded = 46,
    /// Refinancing request was submitted before the cooldown window elapsed.
    RefinanceCooldownActive = 46,
    /// Loan assumption is not authorized by borrower or new borrower.
    AssumptionNotAuthorized = 47,
    /// No pending loan assumption request found for this loan.
    AssumptionNotFound = 48,
    /// A loan assumption request already exists for this loan.
    AssumptionAlreadyRequested = 49,
    /// Withdrawal amount exceeds the pool's configured per-transaction limit.
    WithdrawalExceedsMaxSingleLimit = 50,
    /// Address is not whitelisted when permissioned mode is enabled.
    AddressNotWhitelisted = 51,
}
