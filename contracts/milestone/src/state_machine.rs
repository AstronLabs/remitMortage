// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Explicit oracle for the escrow milestone lifecycle state machine
//! (issue #756).
//!
//! Issue vocabulary → contract status mapping:
//! pending → `Proposed`, submitted/in-review → approval voting on `Proposed`,
//! approved → `Approved`, disputed → `Disputed`, released → `Disbursed`.
//! (`Refunded` is the terminal state for upheld disputes / governance
//! disputes of disbursed milestones.)
//!
//! The table below is the single source of truth for which transitions are
//! valid; `property_tests.rs` asserts live contract behaviour matches it at
//! every step of randomised sequences.

use crate::types::MilestoneStatus;

/// Returns true iff a direct `from → to` transition is reachable through the
/// contract's public entrypoints.
pub fn is_valid_transition(from: &MilestoneStatus, to: &MilestoneStatus) -> bool {
    match (from, to) {
        // Approval quorum reached on a Proposed milestone.
        (MilestoneStatus::Proposed, MilestoneStatus::Approved) => true,
        // Timelocked release of an approved milestone.
        (MilestoneStatus::Approved, MilestoneStatus::Disbursed) => true,
        // Borrower/admin arbitration dispute of an approved milestone.
        (MilestoneStatus::Approved, MilestoneStatus::Disputed) => true,
        // Governance dispute path (dispute_milestone) terminalises directly.
        (MilestoneStatus::Approved, MilestoneStatus::Refunded) => true,
        (MilestoneStatus::Disbursed, MilestoneStatus::Refunded) => true,
        // Arbitration decided against the borrower / timed out → resume.
        (MilestoneStatus::Disputed, MilestoneStatus::Approved) => true,
        // Arbitration upheld → refunded.
        (MilestoneStatus::Disputed, MilestoneStatus::Refunded) => true,
        _ => false,
    }
}

/// All statuses in lifecycle order, for exhaustive invalid-transition checks.
pub const ALL_STATUSES: [MilestoneStatus; 5] = [
    MilestoneStatus::Proposed,
    MilestoneStatus::Approved,
    MilestoneStatus::Disbursed,
    MilestoneStatus::Disputed,
    MilestoneStatus::Refunded,
];
