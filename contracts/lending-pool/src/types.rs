use soroban_sdk::{contracttype, Address, BytesN};

/// Pool configuration set during initialization.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PoolConfig {
    /// Admin address with authority to approve loans and manage the pool.
    pub admin: Address,
    /// USDC token contract address.
    pub token: Address,
    /// Verification registry contract address used to look up borrower scores.
    pub verification_registry: Address,
    /// Annual interest rate in basis points (legacy pool default, subject to dynamic override).
    pub interest_rate_bps: u32,
}

/// Tracks an individual investor's capital contribution.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct InvestorRecord {
    /// Total deposited by this investor.
    pub deposited: i128,
    /// Yield already claimed by this investor.
    pub claimed_yield: i128,
    /// Ledger when first deposit was made.
    pub start_ledger: u32,
}

/// Loan status lifecycle.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum LoanStatus {
    /// Loan has been requested but not yet approved.
    Requested = 0,
    /// Loan is approved and funds can be disbursed in milestones.
    Approved = 1,
    /// Loan has been fully repaid.
    Repaid = 2,
    /// Loan was rejected or cancelled.
    Cancelled = 3,
    /// Loan has defaulted after missed payments.
    Defaulted = 4,
}
 
/// Repayment schedule for a loan, tracked on-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct RepaymentSchedule {
    /// Monthly installment amount (principal + interest portion for the term).
    pub monthly_amount: i128,
    /// Duration of the schedule in months.
    pub duration_months: u32,
    /// Ledger sequence when the next installment is due.
    pub next_due_ledger: u32,
    /// Count of installments paid on-time.
    pub payments_made: u32,
    /// Count of installments missed (consecutive misses are used for default detection).
    pub payments_missed: u32,
}
 
/// A loan record for a borrower.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct LoanRecord {
    /// The borrower's address.
    pub borrower: Address,
    /// Total loan principal (the 70% amount).
    pub principal: i128,
    /// Amount already disbursed to contractors/suppliers.
    pub disbursed: i128,
    /// Amount repaid by the borrower so far.
    pub repaid: i128,
    /// Interest rate in basis points (snapshot from pool config at creation).
    pub interest_rate_bps: u32,
    /// Current loan status.
    pub status: LoanStatus,
    /// Ledger when the loan was created.
    pub created_ledger: u32,
    // schedule moved to separate storage key (LoanSchedule) to avoid optional contracttype encoding issues
}

/// Storage keys for the lending pool contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Pool configuration.
    Config,
    /// Investor record keyed by investor address.
    Investor(Address),
    /// Total available liquidity in the pool.
    TotalLiquidity,
    /// Loan record keyed by a unique loan ID (hash).
    Loan(BytesN<32>),
    /// Repayment schedule keyed by loan ID.
    LoanSchedule(BytesN<32>),
    /// Verification score keyed by borrower address.
    Verification(Address),
    /// Total number of active loans (for tracking).
    LoanCount,
    /// Total interest repaid to the pool.
    TotalRepaidInterest,
    /// Sum of all principal - disbursed for Approved loans.
    ActiveLoanCommitments,
    /// Sum of all investor deposits minus withdrawals.
    TotalDeposited,
}
