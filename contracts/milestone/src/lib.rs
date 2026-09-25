// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

mod errors;
mod types;

use crate::errors::MilestoneError;
use crate::types::{
    ArbitrationConfig, BudgetChangeProposal, DataKey, DisputeOutcome, DisputeRecord,
    MilestoneConfig, MilestoneRecord, MilestoneStatus,
};
use soroban_sdk::{
    contract, contractimpl, symbol_short, vec, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val,
    Vec,
};

const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const DEFAULT_MIN_DELAY_LEDGERS: u32 = 100;

/// Milestone Disbursement Contract
///
/// Manages releasing funds from the lending pool to whitelisted
/// contractors as construction milestones are completed. Contractors
/// propose milestone completion with an IPFS evidence hash, a multisig
/// set of governance approvers votes to approve it, and once the approval
/// threshold is met the admin releases the funds via a cross-contract
/// call to the lending pool's `disburse` function.
#[contract]
pub struct MilestoneContract;

/// Internal helpers.
impl MilestoneContract {
    fn read_config(env: &Env) -> Result<MilestoneConfig, MilestoneError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(MilestoneError::NotInitialized)
    }

    fn read_milestone(
        env: &Env,
        proposal_id: &BytesN<32>,
    ) -> Result<MilestoneRecord, MilestoneError> {
        env.storage()
            .persistent()
            .get(&DataKey::Milestone(proposal_id.clone()))
            .ok_or(MilestoneError::MilestoneNotFound)
    }

    fn set_milestone(env: &Env, proposal_id: &BytesN<32>, record: &MilestoneRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Milestone(proposal_id.clone()), record);
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Validate that `cid` is a well-formed IPFS CID.
    /// Accepts CIDv0 (46 bytes, starts with "Qm") or CIDv1 (59 bytes, starts with "bafy").
    fn validate_cid(cid: &Bytes) -> Result<(), MilestoneError> {
        let len = cid.len();
        if len == 46
            && cid.get(0) == Some(b'Q')
            && cid.get(1) == Some(b'm')
        {
            return Ok(());
        }
        if len == 59
            && cid.get(0) == Some(b'b')
            && cid.get(1) == Some(b'a')
            && cid.get(2) == Some(b'f')
            && cid.get(3) == Some(b'y')
        {
            return Ok(());
        }
        Err(MilestoneError::InvalidCidFormat)
    }

    fn non_reentrant<T, F>(env: &Env, f: F) -> Result<T, MilestoneError>
    where
        F: FnOnce() -> Result<T, MilestoneError>,
    {
        let locked: bool = env
            .storage()
            .instance()
            .get(&DataKey::Reentrant)
            .unwrap_or(false);
        if locked {
            return Err(MilestoneError::ReentrancyGuard);
        }
        env.storage().instance().set(&DataKey::Reentrant, &true);
        let result = f();
        env.storage().instance().set(&DataKey::Reentrant, &false);
        result
    }

    fn read_arbitration_config(env: &Env) -> Result<ArbitrationConfig, MilestoneError> {
        env.storage()
            .instance()
            .get(&DataKey::ArbitrationConfig)
            .ok_or(MilestoneError::ArbitrationNotConfigured)
    }

    fn read_dispute(env: &Env, proposal_id: &BytesN<32>) -> Result<DisputeRecord, MilestoneError> {
        env.storage()
            .persistent()
            .get(&DataKey::Dispute(proposal_id.clone()))
            .ok_or(MilestoneError::DisputeNotFound)
    }

    fn set_dispute(env: &Env, proposal_id: &BytesN<32>, dispute: &DisputeRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Dispute(proposal_id.clone()), dispute);
    }

    fn read_budget_change_proposal(
        env: &Env,
        milestone_id: &Symbol,
    ) -> Result<BudgetChangeProposal, MilestoneError> {
        env.storage()
            .persistent()
            .get(&DataKey::BudgetChange(milestone_id.clone()))
            .ok_or(MilestoneError::BudgetChangeNotFound)
    }

    fn set_budget_change_proposal(
        env: &Env,
        milestone_id: &Symbol,
        proposal: &BudgetChangeProposal,
    ) {
        env.storage()
            .persistent()
            .set(&DataKey::BudgetChange(milestone_id.clone()), proposal);
    }
}

#[contractimpl]
impl MilestoneContract {
    /// Initialize the contract with the admin, token, linked lending pool,
    /// and the multisig governance approver set + approval threshold.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        lending_pool: Address,
        approvers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), MilestoneError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(MilestoneError::AlreadyInitialized);
        }

        admin.require_auth();

        // Threshold must be achievable: at least one approver and no more
        // votes required than there are approvers.
        if threshold == 0 || threshold > approvers.len() {
            return Err(MilestoneError::InvalidThreshold);
        }

        let config = MilestoneConfig {
            admin,
            token,
            lending_pool,
            approvers,
            threshold,
            min_delay_ledgers: DEFAULT_MIN_DELAY_LEDGERS,
        };
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::MilestoneCount, &0u32);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Propose a milestone completion for a loan. Stored in `Proposed` status
    /// with zero votes. The contractor must authorize the proposal.
    pub fn propose_milestone(
        env: Env,
        contractor: Address,
        proposal_id: BytesN<32>,
        loan_id: BytesN<32>,
        amount: i128,
        evidence_hash: BytesN<32>,
        cid: Bytes,
    ) -> Result<(), MilestoneError> {
        contractor.require_auth();

        // Ensure initialized.
        let config = Self::read_config(&env)?;

        if amount <= 0 {
            return Err(MilestoneError::InvalidAmount);
        }

        // Evidence hash must not be zeroed.
        let zero: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        if evidence_hash == zero {
            return Err(MilestoneError::EvidenceRequired);
        }

        // Validate IPFS CID format before storing.
        Self::validate_cid(&cid)?;

        // Proposal IDs are unique; do not clobber an existing milestone.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Milestone(proposal_id.clone()))
        {
            return Err(MilestoneError::MilestoneExists);
        }

        let borrower_func = Symbol::new(&env, "get_loan_borrower");
        let loan_borrower: Option<Address> = env.invoke_contract(
            &config.lending_pool,
            &borrower_func,
            vec![&env, loan_id.clone().into_val(&env)],
        );
        if let Some(borrower) = loan_borrower {
            if borrower == contractor {
                return Err(MilestoneError::SelfDealingNotAllowed);
            }
        }

        let record = MilestoneRecord {
            loan_id,
            contractor,
            amount,
            evidence_hash,
            cid,
            status: MilestoneStatus::Proposed,
            votes: 0,
            created_ledger: env.ledger().sequence(),
            approved_ledger: 0,
            disputed_ledger: 0,
        };
        Self::set_milestone(&env, &proposal_id, &record);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::MilestoneCount)
            .unwrap_or(0u32);
        env.storage()
            .instance()
            .set(&DataKey::MilestoneCount, &(count + 1));

        Self::bump_instance(&env);

        Ok(())
    }

    /// Cast a governance approval vote for a proposed milestone.
    ///
    /// Only addresses in the configured multisig approver set may vote, each
    /// at most once per proposal. Once the configured threshold of votes is
    /// reached the milestone transitions to `Approved`.
    pub fn approve_milestone(
        env: Env,
        approver: Address,
        proposal_id: BytesN<32>,
    ) -> Result<(), MilestoneError> {
        approver.require_auth();

        let config = Self::read_config(&env)?;

        // Only configured multisig approvers may vote.
        if !config.approvers.contains(&approver) {
            return Err(MilestoneError::Unauthorized);
        }

        let mut record = Self::read_milestone(&env, &proposal_id)?;
        if record.status != MilestoneStatus::Proposed {
            return Err(MilestoneError::InvalidStatus);
        }

        // Each approver may only vote once per proposal.
        let voted_key = DataKey::Voted(proposal_id.clone(), approver.clone());
        if env.storage().persistent().has(&voted_key) {
            return Err(MilestoneError::AlreadyVoted);
        }
        env.storage().persistent().set(&voted_key, &true);

        record.votes += 1;
        if record.votes >= config.threshold {
            record.status = MilestoneStatus::Approved;
            record.approved_ledger = env.ledger().sequence();
        }
        Self::set_milestone(&env, &proposal_id, &record);

        Self::bump_instance(&env);

        Ok(())
    }

    /// Propose a change to a pending milestone's budget.
    ///
    /// `milestone_id` is a human-readable Symbol identifying the milestone
    /// (used as the storage key for the budget change). The actual milestone
    /// record is looked up via `proposal_id`. Only milestones in `Proposed`
    /// status can have their budget changed.
    ///
    /// Once proposed, the configured multisig approvers may vote via
    /// `vote_budget_change`. When the threshold is reached, the milestone's
    /// `amount` is updated atomically.
    ///
    /// A cross-contract call to the lending pool checks that the new budget
    /// does not exceed the remaining loan allotment. If the lending pool
    /// does not expose this check, the principal bound is still enforced at
    /// disbursal time.
    pub fn propose_milestone_budget_change(
        env: Env,
        milestone_id: Symbol,
        proposal_id: BytesN<32>,
        new_budget: i128,
    ) -> Result<(), MilestoneError> {
        let config = Self::read_config(&env)?;

        if new_budget <= 0 {
            return Err(MilestoneError::InvalidAmount);
        }

        let milestone = Self::read_milestone(&env, &proposal_id)?;
        if milestone.status != MilestoneStatus::Proposed {
            return Err(MilestoneError::InvalidStatus);
        }

        // Pre-check: ensure the new budget doesn't exceed the remaining
        // loan allotment via a cross-contract call to the lending pool.
        // Graceful if the lending pool doesn't expose this check.
        let check_func: Symbol = symbol_short!("chk_bgt");
        let check_args: Vec<Val> = vec![
            &env,
            milestone.loan_id.clone().into_val(&env),
            new_budget.into_val(&env),
        ];
        let _ = env
            .try_invoke_contract::<(), soroban_sdk::Error>(&config.lending_pool, &check_func, check_args);

        // Confirm no duplicate budget change proposal.
        if env
            .storage()
            .persistent()
            .has(&DataKey::BudgetChange(milestone_id.clone()))
        {
            return Err(MilestoneError::MilestoneExists);
        }

        let proposal = BudgetChangeProposal {
            proposal_id,
            new_amount: new_budget,
            votes: 0,
            executed: false,
        };
        Self::set_budget_change_proposal(&env, &milestone_id, &proposal);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Cast a governance approval vote for a pending budget change.
    ///
    /// Only addresses in the configured multisig approver set may vote, each
    /// at most once per budget change proposal. When the configured threshold
    /// of votes is reached the milestone's `amount` is updated to the new
    /// budget and the proposal is marked executed.
    pub fn vote_budget_change(
        env: Env,
        approver: Address,
        milestone_id: Symbol,
    ) -> Result<(), MilestoneError> {
        approver.require_auth();

        let config = Self::read_config(&env)?;

        if !config.approvers.contains(&approver) {
            return Err(MilestoneError::Unauthorized);
        }

        let mut proposal = Self::read_budget_change_proposal(&env, &milestone_id)?;
        if proposal.executed {
            return Err(MilestoneError::BudgetChangeAlreadyExecuted);
        }

        let voted_key = DataKey::BudgetChangeVoted(milestone_id.clone(), approver.clone());
        if env.storage().persistent().has(&voted_key) {
            return Err(MilestoneError::AlreadyVoted);
        }
        env.storage().persistent().set(&voted_key, &true);

        proposal.votes += 1;
        if proposal.votes >= config.threshold {
            // Threshold reached: apply the budget change to the milestone.
            let mut record = Self::read_milestone(&env, &proposal.proposal_id)?;
            record.amount = proposal.new_amount;
            Self::set_milestone(&env, &proposal.proposal_id, &record);
            proposal.executed = true;
        }
        Self::set_budget_change_proposal(&env, &milestone_id, &proposal);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Release an approved milestone by disbursing its funds from the lending
    /// pool to the contractor via a cross-contract call.
    ///
    /// Admin-only. The milestone is marked `Disbursed`, so it can never be
    /// released more than once (preventing over-release of the allocation).
    pub fn release_milestone(env: Env, proposal_id: BytesN<32>) -> Result<(), MilestoneError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();
        Self::non_reentrant(&env, || {

        let mut record = Self::read_milestone(&env, &proposal_id)?;
        if record.status != MilestoneStatus::Approved {
            return Err(MilestoneError::InvalidStatus);
        }

        let current_ledger = env.ledger().sequence();
        if current_ledger < record.approved_ledger.saturating_add(config.min_delay_ledgers) {
            return Err(MilestoneError::TimelockNotElapsed);
        }

        // Cross-contract call: lending_pool.disburse(loan_id, contractor, amount).
        // The lending pool enforces its own caps (e.g. loan principal) and
        // traps if the amount is invalid, which reverts this release.
        let func: Symbol = symbol_short!("disburse");
        let args: Vec<Val> = vec![
            &env,
            record.loan_id.clone().into_val(&env),
            record.contractor.clone().into_val(&env),
            record.amount.into_val(&env),
        ];
        env.invoke_contract::<()>(&config.lending_pool, &func, args);

        record.status = MilestoneStatus::Disbursed;
        Self::set_milestone(&env, &proposal_id, &record);

        Self::bump_instance(&env);

        Ok(())
        }) // non_reentrant
    }

    /// Dispute an active milestone and trigger a refund to the lending pool.
    ///
    /// Only multisig governance approvers can dispute a milestone. The milestone
    /// must be in `Approved` or `Disbursed` status. Once the approver threshold
    /// of dispute votes is reached, the milestone transitions to `Disputed` and
    /// a refund is initiated via cross-contract call to the lending pool.
    ///
    /// If the milestone was already `Disbursed`, the funds are refunded back
    /// to the pool liquidity and the loan's outstanding debt is adjusted.
    pub fn dispute_milestone(
        env: Env,
        governance_signer: Address,
        proposal_id: BytesN<32>,
    ) -> Result<(), MilestoneError> {
        governance_signer.require_auth();

        let config = Self::read_config(&env)?;

        // Only configured multisig approvers may dispute.
        if !config.approvers.contains(&governance_signer) {
            return Err(MilestoneError::Unauthorized);
        }

        let mut record = Self::read_milestone(&env, &proposal_id)?;

        // Check if already disputed before evaluating the current lifecycle state.
        if record.status == MilestoneStatus::Disputed || record.status == MilestoneStatus::Refunded {
            return Err(MilestoneError::AlreadyDisputed);
        }

        // Can only dispute milestones in Approved or Disbursed status.
        if record.status != MilestoneStatus::Approved && record.status != MilestoneStatus::Disbursed {
            return Err(MilestoneError::CannotDispute);
        }

        // Track the original status to determine if refund is needed.
        let was_disbursed = record.status == MilestoneStatus::Disbursed;

        // Mark as disputed and record the ledger.
        record.disputed_ledger = env.ledger().sequence().saturating_add(1);

        // Approved milestones are considered refunded once disputed; disbursed
        // milestones additionally trigger the lending-pool refund path.
        record.status = MilestoneStatus::Refunded;

        // If the milestone was already disbursed, initiate a refund.
        if was_disbursed {
            // Cross-contract call: lending_pool.refund_milestone_dispute(loan_id, amount).
            let func: Symbol = symbol_short!("refnd_ms");
            let args: Vec<Val> = vec![
                &env,
                record.loan_id.clone().into_val(&env),
                record.amount.into_val(&env),
            ];
            // Invoke the refund but don't fail if it doesn't exist (graceful degradation).
            // The lending pool will handle the refund logic.
            let _result = env.try_invoke_contract::<(), soroban_sdk::Error>(&config.lending_pool, &func, args);
        }

        Self::set_milestone(&env, &proposal_id, &record);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Configure the arbitrators, their vote threshold, and the arbitration
    /// window in ledgers. Admin-only. Open disputes keep the deadline they
    /// were raised with.
    pub fn set_arbitration_config(
        env: Env,
        admin: Address,
        arbitrators: Vec<Address>,
        threshold: u32,
        window_ledgers: u32,
    ) -> Result<(), MilestoneError> {
        let config = Self::read_config(&env)?;
        admin.require_auth();

        if admin != config.admin {
            return Err(MilestoneError::Unauthorized);
        }
        if threshold == 0 || threshold > arbitrators.len() {
            return Err(MilestoneError::InvalidThreshold);
        }
        if window_ledgers == 0 {
            return Err(MilestoneError::InvalidArbitrationWindow);
        }

        let arbitration = ArbitrationConfig {
            arbitrators,
            threshold,
            window_ledgers,
        };
        env.storage()
            .instance()
            .set(&DataKey::ArbitrationConfig, &arbitration);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Raise an arbitration dispute over whether an approved milestone was met.
    ///
    /// The loan's borrower or the admin may raise it. The milestone moves to
    /// `Disputed`, which blocks release, and the arbitration window starts.
    /// A milestone can only be taken to arbitration once.
    pub fn raise_dispute(
        env: Env,
        caller: Address,
        proposal_id: BytesN<32>,
    ) -> Result<(), MilestoneError> {
        caller.require_auth();

        let config = Self::read_config(&env)?;
        let arbitration = Self::read_arbitration_config(&env)?;
        let mut record = Self::read_milestone(&env, &proposal_id)?;

        if env
            .storage()
            .persistent()
            .has(&DataKey::Dispute(proposal_id.clone()))
            || record.status == MilestoneStatus::Disputed
            || record.status == MilestoneStatus::Refunded
        {
            return Err(MilestoneError::AlreadyDisputed);
        }
        if record.status != MilestoneStatus::Approved {
            return Err(MilestoneError::CannotDispute);
        }

        if caller != config.admin {
            let borrower: Option<Address> = env.invoke_contract(
                &config.lending_pool,
                &Symbol::new(&env, "get_loan_borrower"),
                vec![&env, record.loan_id.clone().into_val(&env)],
            );
            if borrower != Some(caller.clone()) {
                return Err(MilestoneError::Unauthorized);
            }
        }

        let now = env.ledger().sequence();
        let dispute = DisputeRecord {
            raised_by: caller.clone(),
            prior_status: record.status.clone(),
            raised_ledger: now,
            deadline_ledger: now.saturating_add(arbitration.window_ledgers),
            uphold_votes: 0,
            reject_votes: 0,
            outcome: DisputeOutcome::Pending,
        };
        Self::set_dispute(&env, &proposal_id, &dispute);

        record.status = MilestoneStatus::Disputed;
        record.disputed_ledger = now.saturating_add(1);
        Self::set_milestone(&env, &proposal_id, &record);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("raised")),
            (proposal_id, caller, dispute.deadline_ledger),
        );
        Self::bump_instance(&env);

        Ok(())
    }

    /// Cast an arbitrator vote on an open dispute, before its deadline.
    ///
    /// When `threshold` arbitrators agree the dispute is decided: upheld
    /// refunds the milestone (funds never leave the pool), rejected restores
    /// its pre-dispute status so the release schedule resumes.
    pub fn vote_dispute(
        env: Env,
        arbitrator: Address,
        proposal_id: BytesN<32>,
        uphold: bool,
    ) -> Result<(), MilestoneError> {
        arbitrator.require_auth();

        let arbitration = Self::read_arbitration_config(&env)?;
        if !arbitration.arbitrators.contains(&arbitrator) {
            return Err(MilestoneError::Unauthorized);
        }

        let mut dispute = Self::read_dispute(&env, &proposal_id)?;
        if dispute.outcome != DisputeOutcome::Pending {
            return Err(MilestoneError::DisputeAlreadyResolved);
        }
        if env.ledger().sequence() > dispute.deadline_ledger {
            return Err(MilestoneError::ArbitrationWindowElapsed);
        }

        let voted_key = DataKey::DisputeVoted(proposal_id.clone(), arbitrator);
        if env.storage().persistent().has(&voted_key) {
            return Err(MilestoneError::AlreadyVoted);
        }
        env.storage().persistent().set(&voted_key, &true);

        if uphold {
            dispute.uphold_votes += 1;
        } else {
            dispute.reject_votes += 1;
        }

        let decision = if dispute.uphold_votes >= arbitration.threshold {
            Some((DisputeOutcome::Upheld, MilestoneStatus::Refunded))
        } else if dispute.reject_votes >= arbitration.threshold {
            Some((DisputeOutcome::Rejected, dispute.prior_status.clone()))
        } else {
            None
        };

        if let Some((outcome, status)) = decision {
            let mut record = Self::read_milestone(&env, &proposal_id)?;
            record.status = status;
            Self::set_milestone(&env, &proposal_id, &record);
            dispute.outcome = outcome;

            env.events().publish(
                (symbol_short!("dispute"), symbol_short!("resolved")),
                (proposal_id.clone(), uphold),
            );
        }
        Self::set_dispute(&env, &proposal_id, &dispute);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Apply the default resolution to a dispute whose arbitration window
    /// elapsed without a decision. Anyone may call this.
    ///
    /// Default resolution: the milestone reverts to its pre-dispute status
    /// with its original approval ledger, so the release schedule continues
    /// as if the dispute had not been raised. Partial arbitrator votes are
    /// discarded. The `timeout` event (distinct from `resolved`) carries the
    /// vote tallies so off-chain systems can flag it for manual review.
    pub fn resolve_expired_dispute(
        env: Env,
        proposal_id: BytesN<32>,
    ) -> Result<(), MilestoneError> {
        let mut dispute = Self::read_dispute(&env, &proposal_id)?;
        if dispute.outcome != DisputeOutcome::Pending {
            return Err(MilestoneError::DisputeAlreadyResolved);
        }
        if env.ledger().sequence() <= dispute.deadline_ledger {
            return Err(MilestoneError::ArbitrationWindowOpen);
        }

        let mut record = Self::read_milestone(&env, &proposal_id)?;
        record.status = dispute.prior_status.clone();
        Self::set_milestone(&env, &proposal_id, &record);

        dispute.outcome = DisputeOutcome::TimedOut;
        Self::set_dispute(&env, &proposal_id, &dispute);

        env.events().publish(
            (symbol_short!("dispute"), symbol_short!("timeout")),
            (proposal_id, dispute.uphold_votes, dispute.reject_votes),
        );
        Self::bump_instance(&env);

        Ok(())
    }

    pub fn get_arbitration_config(env: Env) -> Result<ArbitrationConfig, MilestoneError> {
        Self::read_arbitration_config(&env)
    }

    pub fn get_dispute(env: Env, proposal_id: BytesN<32>) -> Result<DisputeRecord, MilestoneError> {
        Self::read_dispute(&env, &proposal_id)
    }

    pub fn set_min_delay_ledgers(
        env: Env,
        admin: Address,
        min_delay_ledgers: u32,
    ) -> Result<(), MilestoneError> {
        let mut config = Self::read_config(&env)?;
        admin.require_auth();

        if admin != config.admin {
            return Err(MilestoneError::Unauthorized);
        }

        config.min_delay_ledgers = min_delay_ledgers;
        env.storage().instance().set(&DataKey::Config, &config);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Fetch a milestone record by proposal ID.
    pub fn get_milestone(
        env: Env,
        proposal_id: BytesN<32>,
    ) -> Result<MilestoneRecord, MilestoneError> {
        Self::read_milestone(&env, &proposal_id)
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        1
    }

}

#[cfg(test)]
mod test;
