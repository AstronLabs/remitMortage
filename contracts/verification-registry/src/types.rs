use soroban_sdk::{contracttype, Address, BytesN};

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
    /// Ledger sequence after which the verification is considered expired.
    pub expiration_ledger: u32,
}

/// Storage keys for the verification registry contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract admin address.
    Admin,
    /// Verification record keyed by borrower address.
    Verification(Address),
}
