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
}
