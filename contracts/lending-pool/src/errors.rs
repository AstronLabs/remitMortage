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
}
