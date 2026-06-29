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
    /// No pending upgrade exists to execute.
    UpgradeNotPending = 11,
    /// Upgrade was proposed but the timelock delay has not elapsed yet.
    UpgradeTimelockActive = 12,
    /// Investor cannot change tranche after the initial deposit.
    TrancheMismatch = 15,
    /// Junior tranche has insufficient capital to absorb this loss.
    InsufficientJuniorCapital = 16,
    /// Operation rejected because the contract is paused.
    ContractPaused = 13,
    /// Proposed new admin is not the caller or no transfer is pending.
    NotPendingAdmin = 14,
    /// Borrower has no valid, non-expired verification record in the
    /// configured VerificationRegistry, so the loan request is rejected.
    ApplicantNotVerified = 17,
    /// The daily borrow limit has been exceeded.
    DailyBorrowLimitExceeded = 18,
    /// Refund amount exceeds the amount disbursed for the loan.
    RefundExceedsDisbursed = 19,
    /// Disbursement recipient is not a whitelisted contractor.
    UnauthorizedContractor = 20,
    /// Refinancing requires at least 3 successful payments.
    InsufficientPaymentHistory = 21,
    /// Interest rate for refinancing is below the allowed floor.
    InterestRateTooLow = 22,
    /// Loan cannot be refinanced.
    RefinanceNotEligible = 23,
    /// Loan is not yet overdue, so it cannot be marked as defaulted.
    LoanNotOverdue = 24,
}
