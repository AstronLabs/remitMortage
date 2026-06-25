use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum MilestoneError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract has not been initialized yet.
    NotInitialized = 2,
    /// Caller is not authorized to perform the action.
    Unauthorized = 3,
    /// Amount must be greater than zero.
    InvalidAmount = 4,
    /// Milestone not found.
    MilestoneNotFound = 5,
    /// Invalid milestone status for the requested action.
    InvalidStatus = 6,
    /// Evidence hash is required for milestone proposal.
    EvidenceRequired = 7,
    /// A milestone with this proposal ID already exists.
    MilestoneExists = 8,
    /// This approver has already voted on the proposal.
    AlreadyVoted = 9,
    /// Approver set must be non-empty and threshold within 1..=approvers.
    InvalidThreshold = 10,
}
