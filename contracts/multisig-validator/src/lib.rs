// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

mod errors;
mod types;

pub use crate::errors::ValidatorError;
pub use crate::types::{
    AdminMultisigConfig, DataKey, DecayConfig, MultisigConfig, Proposal, ProposalState, Signer,
    SignerVoteRecord, SlashingConfig, TimelockConfig,
};

use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env, Vec};

const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days
const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days

const DEFAULT_DECAY_GRACE_LEDGERS: u32 = 1_000;
const DEFAULT_DECAY_BPS_PER_PERIOD: u32 = 1_000; // 10%
const DEFAULT_DECAY_PERIOD_LEDGERS: u32 = 1_000;
const DEFAULT_DECAY_MIN_BPS: u32 = 1_000; // 10% floor

/// Basis points for full weight.
const BPS_DENOMINATOR: u32 = 10_000;

/// Default proposal lifetime in ledgers when the caller passes 0 at submission.
/// At ~5 seconds per ledger this is approximately 30 days.
#[cfg(not(test))]
const DEFAULT_PROPOSAL_EXPIRY_LEDGERS: u32 = 518_400;
/// Compact default used in tests so expiry can be crossed with small ledger advances.
#[cfg(test)]
const DEFAULT_PROPOSAL_EXPIRY_LEDGERS: u32 = 1_000;

/// Multisig Threshold Validator
///
/// Verifies that the cumulative weight of the signers presented on a proposal
/// meets or exceeds the configured threshold for a multisig account — mirroring
/// Stellar's native multi-signature thresholds (each `signer` carries a
/// `weight`, and an operation is authorized only when the sum of the weights of
/// the signing keys reaches the required threshold).
///
/// Rather than re-implementing per-contract `votes >= threshold` counters, other
/// contracts (e.g. the milestone approval flow) can delegate to this validator
/// so threshold logic lives in one audited place.
#[contract]
pub struct MultisigValidator;

impl MultisigValidator {
    fn read_config(env: &Env, account: &Address) -> Result<MultisigConfig, ValidatorError> {
        env.storage()
            .persistent()
            .get(&DataKey::Config(account.clone()))
            .ok_or(ValidatorError::AccountNotConfigured)
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Validate a signer set: non-empty, no zero weights, no duplicate keys.
    /// Returns the total configurable weight on success.
    fn validate_signers(signers: &Vec<Signer>) -> Result<u32, ValidatorError> {
        let len = signers.len();
        if len == 0 {
            return Err(ValidatorError::NoSigners);
        }

        let mut total: u32 = 0;
        for i in 0..len {
            let s = signers.get_unchecked(i);
            if s.weight == 0 {
                return Err(ValidatorError::InvalidWeight);
            }
            // Reject duplicate keys.
            for j in (i + 1)..len {
                if signers.get_unchecked(j).key == s.key {
                    return Err(ValidatorError::DuplicateSigner);
                }
            }
            total = total.saturating_add(s.weight);
        }
        Ok(total)
    }

    /// Look up the configured weight of a single key, or `None` if not a signer.
    fn weight_of(config: &MultisigConfig, key: &BytesN<32>) -> Option<u32> {
        let signers = &config.signers;
        for i in 0..signers.len() {
            let s = signers.get_unchecked(i);
            if &s.key == key {
                return Some(s.weight);
            }
        }
        None
    }

    /// Return `true` when the current ledger sequence has passed the proposal's
    /// `expiration_ledger`.
    ///
    /// A value of `0` means the field was not set (legacy record) — treated as
    /// non-expiring to preserve backwards compatibility.
    fn is_expired(env: &Env, proposal: &Proposal) -> bool {
        if proposal.expiration_ledger == 0 {
            return false; // legacy / no-expiry
        }
        env.ledger().sequence() > proposal.expiration_ledger
    }

    /// Current decay config, falling back to defaults.
    fn read_decay_config(env: &Env) -> DecayConfig {
        env.storage()
            .instance()
            .get(&DataKey::DecayConfig)
            .unwrap_or(DecayConfig {
                grace_ledgers: DEFAULT_DECAY_GRACE_LEDGERS,
                decay_bps_per_period: DEFAULT_DECAY_BPS_PER_PERIOD,
                period_ledgers: DEFAULT_DECAY_PERIOD_LEDGERS,
                min_weight_bps: DEFAULT_DECAY_MIN_BPS,
            })
    }

    /// Basis points of weight lost to inactivity. 0 inside grace, linear after.
    fn decay_bps(env: &Env, last_vote_ledger: u32, cfg: &DecayConfig) -> u32 {
        if cfg.decay_bps_per_period == 0 || cfg.period_ledgers == 0 {
            return 0;
        }
        let now = env.ledger().sequence();
        // last_vote_ledger == 0 means never voted — initialize to now (full weight)
        let anchor = if last_vote_ledger == 0 { now } else { last_vote_ledger };
        if now <= anchor {
            return 0;
        }
        let elapsed = now - anchor;
        if elapsed <= cfg.grace_ledgers {
            return 0;
        }
        let overdue = (elapsed - cfg.grace_ledgers) as u64;
        let bps = overdue.saturating_mul(cfg.decay_bps_per_period as u64)
            / cfg.period_ledgers as u64;
        bps.min((BPS_DENOMINATOR - cfg.min_weight_bps) as u64) as u32
    }

    /// Apply decay + slashing to a base weight.
    fn apply_decay(base: u32, decay_bps: u32, cfg: &DecayConfig) -> u32 {
        let reduction = (base as u64 * decay_bps as u64 / BPS_DENOMINATOR as u64) as u32;
        let floor = ((base as u64 * cfg.min_weight_bps as u64) / BPS_DENOMINATOR as u64) as u32;
        base.saturating_sub(reduction).max(floor).max(1)
    }
}

#[contractimpl]
impl MultisigValidator {
    /// Register (or re-register) a multisig account's weighted signer set and
    /// required threshold. The account itself must authorize the registration,
    /// matching the native model where only the account can change its signers.
    ///
    /// The threshold must be achievable: `0 < threshold <= sum(weights)`.
    pub fn configure_account(
        env: Env,
        account: Address,
        signers: Vec<Signer>,
        threshold: u32,
    ) -> Result<(), ValidatorError> {
        account.require_auth();

        let total_weight = Self::validate_signers(&signers)?;
        if threshold == 0 || threshold > total_weight {
            return Err(ValidatorError::InvalidThreshold);
        }

        env.storage()
            .persistent()
            .set(&DataKey::Config(account.clone()), &MultisigConfig { signers, threshold });
        Self::bump_instance(&env);
        Ok(())
    }

    /// Returns the cumulative weight of `signing_keys` against the account's
    /// configured signer set, **trapping** if a key is unknown or appears twice.
    ///
    /// Used internally by `verify_threshold`/`enforce_threshold`; exposed so
    /// callers can inspect a tally.
    pub fn tally_weight(
        env: Env,
        account: Address,
        signing_keys: Vec<BytesN<32>>,
    ) -> Result<u32, ValidatorError> {
        let config = Self::read_config(&env, &account)?;

        let len = signing_keys.len();
        let mut total: u32 = 0;
        for i in 0..len {
            let key = signing_keys.get_unchecked(i);

            // Reject duplicate presented keys (no double-counting weight).
            for j in (i + 1)..len {
                if signing_keys.get_unchecked(j) == key {
                    return Err(ValidatorError::DuplicateSigner);
                }
            }

            match Self::weight_of(&config, &key) {
                Some(w) => total = total.saturating_add(w),
                None => return Err(ValidatorError::UnknownSigner),
            }
        }
        Ok(total)
    }

    /// Returns `true` iff the cumulative weight of `signing_keys` meets or
    /// exceeds the account's configured threshold. Traps on unknown/duplicate
    /// keys (a malformed signature set is an error, not a `false`).
    pub fn verify_threshold(
        env: Env,
        account: Address,
        signing_keys: Vec<BytesN<32>>,
    ) -> Result<bool, ValidatorError> {
        let config = Self::read_config(&env, &account)?;
        let total = Self::tally_weight(env, account, signing_keys)?;
        Ok(total >= config.threshold)
    }

    /// Like `verify_threshold` but returns an `InsufficientWeight` error instead
    /// of `false`. Convenient for callers that want a single `?`-propagatable
    /// gate before approving a proposal/milestone.
    pub fn enforce_threshold(
        env: Env,
        account: Address,
        signing_keys: Vec<BytesN<32>>,
    ) -> Result<(), ValidatorError> {
        if Self::verify_threshold(env, account, signing_keys)? {
            Ok(())
        } else {
            Err(ValidatorError::InsufficientWeight)
        }
    }

    /// Returns the configured threshold for an account.
    pub fn get_threshold(env: Env, account: Address) -> Result<u32, ValidatorError> {
        Ok(Self::read_config(&env, &account)?.threshold)
    }

    /// Returns the full multisig configuration for an account.
    pub fn get_config(env: Env, account: Address) -> Result<MultisigConfig, ValidatorError> {
        Self::read_config(&env, &account)
    }

    /// Returns the total configurable signer weight for an account.
    pub fn total_weight(env: Env, account: Address) -> Result<u32, ValidatorError> {
        let config = Self::read_config(&env, &account)?;
        Self::validate_signers(&config.signers)
    }

    // ── Timelock ───────────────────────────────────────────────────────────────

    /// Configure the timelock delay for `account`. The account itself must
    /// authorize. A delay of 0 disables the timelock (immediate execution).
    pub fn configure_timelock(
        env: Env,
        account: Address,
        delay_seconds: u64,
    ) -> Result<(), ValidatorError> {
        account.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::TimelockConfig(account), &TimelockConfig { delay_seconds });
        Self::bump_instance(&env);
        Ok(())
    }

    /// Return the configured timelock delay for `account`.
    pub fn get_timelock(env: Env, account: Address) -> Result<TimelockConfig, ValidatorError> {
        env.storage()
            .persistent()
            .get(&DataKey::TimelockConfig(account))
            .ok_or(ValidatorError::TimelockNotConfigured)
    }

    /// Submit a new action proposal. `proposal_id` should be a unique 32-byte
    /// value (e.g. a hash of the action details). Anyone may submit.
    ///
    /// # Arguments
    /// - `proposal_id`       — Unique 32-byte identifier (e.g. SHA-256 of action details).
    /// - `expiration_ledger` — Ledger sequence number after which the proposal is
    ///   considered expired and eligible for pruning.  Pass `0` to use the
    ///   protocol default (`DEFAULT_PROPOSAL_EXPIRY_LEDGERS` from the current
    ///   ledger sequence).
    pub fn submit_action(
        env: Env,
        proposal_id: BytesN<32>,
        expiration_ledger: u32,
    ) -> Result<(), ValidatorError> {
        let now = env.ledger().timestamp();
        let current_seq = env.ledger().sequence();

        let effective_expiry = if expiration_ledger == 0 {
            current_seq.saturating_add(DEFAULT_PROPOSAL_EXPIRY_LEDGERS)
        } else {
            expiration_ledger
        };

        let proposal = Proposal {
            state: ProposalState::Pending,
            ready_at: 0,
            created_at: now,
            expiration_ledger: effective_expiry,
        };
        env.storage()
            .persistent()
            .set(&DataKey::ActionProposal(proposal_id.clone()), &proposal);

        env.events().publish(
            (symbol_short!("submitted"),),
            (proposal_id, effective_expiry),
        );

        Self::bump_instance(&env);
        Ok(())
    }

    /// Approve a proposal with the given `signing_keys`. Once the cumulative
    /// weight meets the account's threshold, the proposal transitions from
    /// `Pending` to `Locked` and the timelock countdown begins.
    ///
    /// Returns `ProposalExpired` when the current ledger sequence has passed
    /// the proposal's `expiration_ledger`.
    pub fn approve_action(
        env: Env,
        account: Address,
        proposal_id: BytesN<32>,
        signing_keys: Vec<BytesN<32>>,
    ) -> Result<(), ValidatorError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::ActionProposal(proposal_id.clone()))
            .ok_or(ValidatorError::ProposalNotFound)?;

        if proposal.state == ProposalState::Executed {
            return Err(ValidatorError::ProposalAlreadyExecuted);
        }

        // Reject votes on expired proposals before any other state check.
        if Self::is_expired(&env, &proposal) {
            return Err(ValidatorError::ProposalExpired);
        }

        // Already locked — no-op.
        if proposal.state == ProposalState::Locked {
            return Ok(());
        }

        // Check threshold via existing logic.
        Self::enforce_threshold(env.clone(), account.clone(), signing_keys.clone())?;

        // Threshold met. Fetch timelock config and set ready_at.
        let timelock = Self::get_timelock(env.clone(), account.clone())?;
        let now = env.ledger().timestamp();
        proposal.state = ProposalState::Locked;
        proposal.ready_at = now.saturating_add(timelock.delay_seconds);

        env.storage()
            .persistent()
            .set(&DataKey::ActionProposal(proposal_id), &proposal);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Returns `true` if the proposal has been approved and the timelock delay
    /// has elapsed. Returns `false` if pending, locked-but-not-ready, or
    /// already executed.
    pub fn can_execute(env: Env, proposal_id: BytesN<32>) -> Result<bool, ValidatorError> {
        let proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::ActionProposal(proposal_id))
            .ok_or(ValidatorError::ProposalNotFound)?;

        match proposal.state {
            ProposalState::Locked => Ok(env.ledger().timestamp() >= proposal.ready_at),
            ProposalState::Executed => Ok(false),
            ProposalState::Pending => Ok(false),
        }
    }

    /// Execute a timelocked proposal. Fails if not Locked, if the timelock
    /// delay has not yet elapsed, or if the proposal has expired.
    pub fn execute_action(
        env: Env,
        proposal_id: BytesN<32>,
    ) -> Result<(), ValidatorError> {
        let mut proposal: Proposal = env
            .storage()
            .persistent()
            .get(&DataKey::ActionProposal(proposal_id.clone()))
            .ok_or(ValidatorError::ProposalNotFound)?;

        if proposal.state == ProposalState::Executed {
            return Err(ValidatorError::ProposalAlreadyExecuted);
        }
        if proposal.state != ProposalState::Locked {
            return Err(ValidatorError::NotYetApproved);
        }

        // A Locked proposal that somehow crosses its expiry without being
        // executed is also blocked — the approval window has closed.
        if Self::is_expired(&env, &proposal) {
            return Err(ValidatorError::ProposalExpired);
        }

        let now = env.ledger().timestamp();
        if now < proposal.ready_at {
            return Err(ValidatorError::TimelockNotElapsed);
        }

        proposal.state = ProposalState::Executed;
        env.storage()
            .persistent()
            .set(&DataKey::ActionProposal(proposal_id), &proposal);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Read a proposal's current state.
    pub fn get_proposal(env: Env, proposal_id: BytesN<32>) -> Result<Proposal, ValidatorError> {
        env.storage()
            .persistent()
            .get(&DataKey::ActionProposal(proposal_id))
            .ok_or(ValidatorError::ProposalNotFound)
    }

    // ── Admin-managed k-of-n signer configuration ───────────────────────────────

    /// Initialize the admin authorized to manage the `k-of-n` signer set.
    /// Can only be called once; subsequent calls fail with `AdminAlreadySet`.
    pub fn init_admin(env: Env, admin: Address) -> Result<(), ValidatorError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(ValidatorError::AdminAlreadySet);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Return the configured admin.
    pub fn get_admin(env: Env) -> Result<Address, ValidatorError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ValidatorError::AdminNotSet)
    }

    fn require_admin(env: &Env) -> Result<Address, ValidatorError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(ValidatorError::AdminNotSet)?;
        admin.require_auth();
        Ok(admin)
    }

    fn read_admin_config(env: &Env) -> Result<AdminMultisigConfig, ValidatorError> {
        env.storage()
            .persistent()
            .get(&DataKey::AdminConfig)
            .ok_or(ValidatorError::AdminConfigNotSet)
    }

    fn write_admin_config(env: &Env, config: &AdminMultisigConfig) {
        env.storage().persistent().set(&DataKey::AdminConfig, config);
        Self::bump_instance(env);
    }

    /// Register the initial admin-managed signer set and required threshold.
    /// Requires the admin's signature. The threshold must satisfy
    /// `0 < threshold <= signers.len()`, and the signer set must contain no
    /// duplicate addresses.
    pub fn configure_signers(
        env: Env,
        signers: Vec<Address>,
        threshold: u32,
    ) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;

        let len = signers.len();
        // Reject duplicate signer addresses.
        for i in 0..len {
            let a = signers.get_unchecked(i);
            for j in (i + 1)..len {
                if signers.get_unchecked(j) == a {
                    return Err(ValidatorError::SignerAlreadyExists);
                }
            }
        }

        if threshold == 0 || threshold > len {
            return Err(ValidatorError::InvalidThreshold);
        }

        Self::write_admin_config(&env, &AdminMultisigConfig { signers, threshold });
        Ok(())
    }

    /// Update the required signature threshold. Requires the admin's signature.
    /// Rejects a threshold of 0 or one that exceeds the number of active
    /// signers (`InvalidThreshold`).
    pub fn set_threshold(env: Env, threshold: u32) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;

        let mut config = Self::read_admin_config(&env)?;
        if threshold == 0 || threshold > config.signers.len() {
            return Err(ValidatorError::InvalidThreshold);
        }
        config.threshold = threshold;
        Self::write_admin_config(&env, &config);
        Ok(())
    }

    /// Update the required quorum signature threshold. Requires admin signature.
    pub fn set_quorum_threshold(env: Env, threshold: u32) -> Result<(), ValidatorError> {
        Self::set_threshold(env, threshold)
    }

    /// Add an address to the admin-managed signer set. Requires the admin's
    /// signature. Fails with `SignerAlreadyExists` if the address is already a
    /// signer.
    pub fn add_signer(env: Env, signer: Address) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;

        let mut config = Self::read_admin_config(&env)?;
        for i in 0..config.signers.len() {
            if config.signers.get_unchecked(i) == signer {
                return Err(ValidatorError::SignerAlreadyExists);
            }
        }
        config.signers.push_back(signer);
        Self::write_admin_config(&env, &config);
        Ok(())
    }

    /// Remove an address from the admin-managed signer set. Requires the admin's
    /// signature. Fails if the address is not a signer, or if removing it would
    /// leave fewer signers than the configured threshold (`InvalidThreshold`).
    pub fn remove_signer(env: Env, signer: Address) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;

        let mut config = Self::read_admin_config(&env)?;
        let mut found: Option<u32> = None;
        for i in 0..config.signers.len() {
            if config.signers.get_unchecked(i) == signer {
                found = Some(i);
                break;
            }
        }
        let idx = found.ok_or(ValidatorError::SignerNotFound)?;

        if config.signers.len() - 1 < config.threshold {
            return Err(ValidatorError::InvalidThreshold);
        }
        config.signers.remove(idx);
        Self::write_admin_config(&env, &config);
        Ok(())
    }

    /// Return the current admin-managed signer configuration.
    pub fn get_signer_config(env: Env) -> Result<AdminMultisigConfig, ValidatorError> {
        Self::read_admin_config(&env)
    }

    /// Count how many of the presented `signers` are valid members of the
    /// admin-managed signer set. Duplicate presented addresses are counted once,
    /// and addresses not in the configured set are ignored.
    pub fn count_valid_signers(
        env: Env,
        signers: Vec<Address>,
    ) -> Result<u32, ValidatorError> {
        let config = Self::read_admin_config(&env)?;

        let len = signers.len();
        let mut count: u32 = 0;
        for i in 0..len {
            let addr = signers.get_unchecked(i);

            // Skip duplicates already seen earlier in the presented list.
            let mut seen = false;
            for j in 0..i {
                if signers.get_unchecked(j) == addr {
                    seen = true;
                    break;
                }
            }
            if seen {
                continue;
            }

            // Count only addresses that are configured signers.
            for k in 0..config.signers.len() {
                if config.signers.get_unchecked(k) == addr {
                    count += 1;
                    break;
                }
            }
        }
        Ok(count)
    }

    /// Returns `true` iff the number of distinct valid signers presented meets
    /// or exceeds the configured threshold.
    pub fn verify_signatures(
        env: Env,
        signers: Vec<Address>,
    ) -> Result<bool, ValidatorError> {
        let config = Self::read_admin_config(&env)?;
        let count = Self::count_valid_signers(env, signers)?;
        Ok(count >= config.threshold)
    }

    /// Like `verify_signatures` but reverts with `InsufficientWeight` when the
    /// number of valid signatures is below the configured threshold. Convenient
    /// as a single `?`-propagatable authorization gate.
    pub fn enforce_signatures(
        env: Env,
        signers: Vec<Address>,
    ) -> Result<(), ValidatorError> {
        if Self::verify_signatures(env, signers)? {
            Ok(())
        } else {
            Err(ValidatorError::InsufficientWeight)
        }
    }

    // ── Slashing: Missed Vote Penalty ─────────────────────────────────────────

    /// Configure the slashing penalty parameters. Requires admin signature.
    pub fn configure_slashing(
        env: Env,
        missed_vote_threshold: u32,
        penalty_weight_reduction_pct: u32,
        recovery_active_votes: u32,
    ) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;

        if missed_vote_threshold == 0 {
            return Err(ValidatorError::InvalidThreshold);
        }
        if penalty_weight_reduction_pct > 100 {
            return Err(ValidatorError::InvalidThreshold);
        }
        if recovery_active_votes == 0 {
            return Err(ValidatorError::InvalidThreshold);
        }

        let config = SlashingConfig {
            missed_vote_threshold,
            penalty_weight_reduction_pct,
            recovery_active_votes,
        };
        env.storage().persistent().set(&DataKey::SlashingConfig, &config);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Returns the current slashing configuration.
    pub fn get_slashing_config(env: Env) -> Result<SlashingConfig, ValidatorError> {
        Ok(env
            .storage()
            .persistent()
            .get(&DataKey::SlashingConfig)
            .unwrap_or_default())
    }

    /// Read a signer's vote record for a given account.
    pub fn get_signer_vote_record(
        env: Env,
        account: Address,
        signer: Address,
    ) -> Result<SignerVoteRecord, ValidatorError> {
        let now = env.ledger().sequence().max(1);
        Ok(env
            .storage()
            .persistent()
            .get(&DataKey::SignerVoteRecord(account, signer))
            .unwrap_or(SignerVoteRecord {
                consecutive_missed: 0,
                consecutive_active: 0,
                penalized: false,
                last_vote_ledger: now,
            }))
    }

    /// Record that a signer voted on a proposal (resets missed count,
    /// increments active count, potentially resets penalty, and resets decay clock).
    fn record_vote(env: &Env, account: &Address, signer: &Address) {
        let slashing = Self::read_slashing_config(env);
        let now = env.ledger().sequence().max(1);
        let mut record: SignerVoteRecord = env
            .storage()
            .persistent()
            .get(&DataKey::SignerVoteRecord(account.clone(), signer.clone()))
            .unwrap_or(SignerVoteRecord {
                consecutive_missed: 0,
                consecutive_active: 0,
                penalized: false,
                last_vote_ledger: now,
            });

        record.consecutive_missed = 0;
        record.consecutive_active += 1;
        record.last_vote_ledger = now;

        // Reset penalty if sustained active participation reached
        if record.penalized && record.consecutive_active >= slashing.recovery_active_votes {
            record.penalized = false;
        }

        env.storage().persistent().set(
            &DataKey::SignerVoteRecord(account.clone(), signer.clone()),
            &record,
        );
    }

    /// Public entry to record a vote — restores weight and resets decay clock.
    pub fn cast_vote(env: Env, account: Address, signer: Address) -> Result<(), ValidatorError> {
        let cfg = Self::read_admin_config(&env)?;
        let mut recognized = false;
        for s in cfg.signers.iter() {
            if s == signer {
                recognized = true;
            }
        }
        if !recognized {
            return Err(ValidatorError::UnknownSigner);
        }
        Self::record_vote(&env, &account, &signer);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Record that a signer missed a proposal (increments missed count,
    /// resets active count, applies penalty if threshold exceeded).
    fn record_miss(env: &Env, account: &Address, signer: &Address) {
        let slashing = Self::read_slashing_config(env);
        let now = env.ledger().sequence().max(1);
        let mut record: SignerVoteRecord = env
            .storage()
            .persistent()
            .get(&DataKey::SignerVoteRecord(account.clone(), signer.clone()))
            .unwrap_or(SignerVoteRecord {
                consecutive_missed: 0,
                consecutive_active: 0,
                penalized: false,
                last_vote_ledger: now,
            });

        record.consecutive_missed += 1;
        record.consecutive_active = 0;

        // Apply penalty if threshold exceeded
        if record.consecutive_missed >= slashing.missed_vote_threshold {
            record.penalized = true;
        }

        env.storage().persistent().set(
            &DataKey::SignerVoteRecord(account.clone(), signer.clone()),
            &record,
        );
    }

    /// Returns the effective weight of a signer, accounting for penalty and
    /// time-weighted decay. Base weight is looked up from the admin config
    /// (currently 100 for each signer; future weighted admin can extend this).
    /// `last_vote_ledger == 0` is treated as `now` so a new signer starts inside
    /// the grace window with full weight.
    pub fn effective_weight(
        env: Env,
        account: Address,
        signer: Address,
    ) -> Result<u32, ValidatorError> {
        let config = Self::read_admin_config(&env)?;
        let slashing = Self::read_slashing_config(&env);
        let decay_cfg = Self::read_decay_config(&env);

        let mut recognized = false;
        for configured_signer in config.signers.iter() {
            if configured_signer == signer {
                recognized = true;
            }
        }
        if !recognized {
            return Err(ValidatorError::UnknownSigner);
        }
        // Base weight lookup: admin signers are uniform weight 100 (so decay is visible).
        // If a future weighted admin stores per-signer weights, replace this lookup.
        let base_weight: u32 = 100;

        // Load record, initializing last_vote_ledger to now if never voted.
        let now = env.ledger().sequence();
        let record: SignerVoteRecord = env
            .storage()
            .persistent()
            .get(&DataKey::SignerVoteRecord(account.clone(), signer.clone()))
            .unwrap_or(SignerVoteRecord {
                consecutive_missed: 0,
                consecutive_active: 0,
                penalized: false,
                last_vote_ledger: now,
            });
        let effective_anchor = if record.last_vote_ledger == 0 {
            now
        } else {
            record.last_vote_ledger
        };

        // Start from base, apply slashing first
        let mut weight = base_weight;
        if record.penalized {
            let reduction = (base_weight * slashing.penalty_weight_reduction_pct) / 100;
            weight = base_weight.saturating_sub(reduction).max(1);
        }

        // Then apply time-weighted decay (linear after grace)
        let decay_bps = Self::decay_bps(&env, effective_anchor, &decay_cfg);
        if decay_bps > 0 {
            weight = Self::apply_decay(weight, decay_bps, &decay_cfg);
        }

        Ok(weight)
    }

    /// Mark expired proposals and update signer vote records.
    /// Should be called periodically or before tallying votes.
    pub fn mark_missed_votes(
        env: Env,
        account: Address,
        expired_proposal_ids: Vec<BytesN<32>>,
    ) -> Result<(), ValidatorError> {
        let config = Self::read_admin_config(&env)?;

        // For each expired proposal, mark all signers who didn't vote as missed
        for i in 0..expired_proposal_ids.len() {
            let pid = expired_proposal_ids.get_unchecked(i);
            let proposal: Proposal = match env
                .storage()
                .persistent()
                .get(&DataKey::ActionProposal(pid))
            {
                Some(p) => p,
                None => continue,
            };

            // Only process pending proposals that expired
            if proposal.state != ProposalState::Pending || !Self::is_expired(&env, &proposal) {
                continue;
            }

            // Mark all signers as having missed this proposal
            for j in 0..config.signers.len() {
                let signer = config.signers.get_unchecked(j);
                Self::record_miss(&env, &account, &signer);
            }
        }

        Self::bump_instance(&env);
        Ok(())
    }

    /// Admin endpoint to reset a signer's penalty manually.
    pub fn reset_signer_penalty(
        env: Env,
        signer: Address,
    ) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;

        // Reset for all accounts this signer might belong to
        // Note: In practice, the admin would need to know the account.
        // This is a simplified version that stores a global reset flag.
        let now = env.ledger().sequence().max(1);
        let record = SignerVoteRecord {
            consecutive_missed: 0,
            consecutive_active: 0,
            penalized: false,
            last_vote_ledger: now,
        };
        // Store with a placeholder account; in production you'd iterate accounts
        // For now, this is a best-effort reset
        let admin = Self::get_admin(env.clone())?;
        env.storage().persistent().set(
            &DataKey::SignerVoteRecord(admin, signer),
            &record,
        );
        Self::bump_instance(&env);
        Ok(())
    }

    /// Read the slashing config, returning default if not set.
    fn read_slashing_config(env: &Env) -> SlashingConfig {
        env.storage()
            .persistent()
            .get(&DataKey::SlashingConfig)
            .unwrap_or_default()
    }

    /// Configure time-weighted decay. Admin-only.
    pub fn configure_decay(
        env: Env,
        grace_ledgers: u32,
        decay_bps_per_period: u32,
        period_ledgers: u32,
        min_weight_bps: u32,
    ) -> Result<(), ValidatorError> {
        Self::require_admin(&env)?;
        if period_ledgers == 0 || decay_bps_per_period > BPS_DENOMINATOR || min_weight_bps > BPS_DENOMINATOR {
            return Err(ValidatorError::InvalidThreshold);
        }
        let cfg = DecayConfig { grace_ledgers, decay_bps_per_period, period_ledgers, min_weight_bps };
        env.storage().instance().set(&DataKey::DecayConfig, &cfg);
        Self::bump_instance(&env);
        Ok(())
    }

    /// Returns current decay config, or defaults if not set.
    pub fn get_decay_config(env: Env) -> DecayConfig {
        Self::read_decay_config(&env)
    }

    /// Contract version.
    pub fn version(_env: Env) -> u32 {
        3
    }
}

#[cfg(test)]
mod test;
