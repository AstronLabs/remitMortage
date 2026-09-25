// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::{contracttype, Address, Bytes, BytesN, Symbol, Vec};

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
    /// Minimum number of ledgers that must elapse between approval and release.
    pub min_delay_ledgers: u32,
}

/// Milestone status lifecycle.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum MilestoneStatus {
    Proposed = 0,
    Approved = 1,
    Disbursed = 2,
    Disputed = 3,
    Refunded = 4,
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
    /// IPFS CID string (v0: 46 chars starting "Qm", v1: 59 chars starting "bafy").
    pub cid: Bytes,
    /// Current status in the lifecycle.
    pub status: MilestoneStatus,
    /// Number of governance votes the proposal has received.
    pub votes: u32,
    /// Ledger sequence at which the milestone was proposed.
    pub created_ledger: u32,
    /// Ledger sequence at which the milestone was approved and the timelock began.
    pub approved_ledger: u32,
    /// Ledger sequence at which the milestone was disputed (0 if not disputed).
    pub disputed_ledger: u32,
}

/// A proposal to change the budget for an existing (pending) milestone.
/// Keyed by `Symbol` (human-readable milestone id) in storage.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BudgetChangeProposal {
    /// Links to the actual `MilestoneRecord` (keyed by BytesN<32>).
    pub proposal_id: BytesN<32>,
    /// The new requested budget amount.
    pub new_amount: i128,
    /// Number of governance votes received so far.
    pub votes: u32,
    /// Whether the change has been applied to the milestone record.
    pub executed: bool,
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
    /// Reentrancy guard flag — true while a mutating function is executing.
    Reentrant,
    /// Budget change proposal keyed by milestone Symbol.
    BudgetChange(Symbol),
    /// Tracks whether an approver has voted on a budget change.
    BudgetChangeVoted(Symbol, Address),
}
