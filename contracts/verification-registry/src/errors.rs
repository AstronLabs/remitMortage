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
}
