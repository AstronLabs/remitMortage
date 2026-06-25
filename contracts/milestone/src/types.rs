use soroban_sdk::{contracttype, Address, BytesN, Vec};

/// Configuration for the milestone disbursement contract.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneConfig {
    /// Address authorized to release approved milestones.
    pub admin: Address,
    /// Token used by the linked lending pool (USDC).
    pub token: Address,
    /// Address of the lending pool that holds the loan capital.
    pub lending_pool: Address,
    /// Multisig governance signers allowed to approve milestones.
    pub approvers: Vec<Address>,
    /// Number of approver votes required to approve a milestone.
    pub threshold: u32,
}

/// Milestone status lifecycle.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum MilestoneStatus {
    Proposed = 0,
    Approved = 1,
    Disbursed = 2,
}

/// Milestone record stored on-chain.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MilestoneRecord {
    /// Loan / project this milestone draws funds from.
    pub loan_id: BytesN<32>,
    /// Contractor who receives the disbursement.
    pub contractor: Address,
    /// Amount to release for this milestone.
    pub amount: i128,
    /// IPFS evidence hash (content digest) proving milestone completion.
    pub evidence_hash: BytesN<32>,
    /// Current status in the lifecycle.
    pub status: MilestoneStatus,
    /// Number of governance votes the proposal has received.
    pub votes: u32,
    /// Ledger sequence at which the milestone was proposed.
    pub created_ledger: u32,
}

/// Storage keys for the milestone contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Contract configuration.
    Config,
    /// Milestone keyed by proposal ID (BytesN<32>).
    Milestone(BytesN<32>),
    /// Tracks whether an approver has already voted on a proposal.
    Voted(BytesN<32>, Address),
    /// Total number of milestones proposed.
    MilestoneCount,
}
