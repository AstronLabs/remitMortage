// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, Address, Bytes, Env, IntoVal, Map, Symbol,
    Vec,
};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStatus {
    Open,
    Passed,
    Rejected,
    Executed,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceConfig {
    pub admin: Address,
    pub guardian: Address,
    pub signers: Vec<Address>,
    pub quorum_bps: u32, // Quorum in basis points, e.g. 6000 = 60%
    /// Address of the StakingPool contract used to resolve a proposer's
    /// stake at submission time. `None` disables the minimum-stake check
    /// entirely, preserving unrestricted submission. Set via
    /// `set_staking_pool`.
    pub staking_pool: Option<Address>,
    /// Minimum stake (in the StakingPool's share units) a proposer must
    /// hold to submit a new proposal. `0` — the deployment default —
    /// disables the check entirely. Set via `set_min_stake_to_submit`.
    pub min_stake_to_submit: i128,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Proposal {
    pub milestone_id: u32,
    pub evidence_hash: Bytes,
    pub vote_count: u32,
    pub voters: Vec<Address>,
    pub status: ProposalStatus,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Config,
    Proposal(u32),
    LastProposalId,
    /// A signer's active delegate, keyed by the delegating signer.
    Delegation(Address),
    /// Voting power per signer frozen when a proposal was submitted, keyed by
    /// proposal ID. Absent for proposals created before delegation existed.
    PowerSnapshot(u32),
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initializes the governance wrapper with an admin, a guardian, a list of signers, and a quorum threshold.
    pub fn initialize(
        env: Env,
        admin: Address,
        guardian: Address,
        signers: Vec<Address>,
        quorum_bps: u32,
    ) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("Already initialized");
        }
        if quorum_bps > 10000 {
            panic!("Quorum basis points cannot exceed 10000");
        }
        if signers.contains(&guardian) {
            panic!("Guardian cannot be a signer");
        }

        let config = GovernanceConfig {
            admin,
            guardian,
            signers,
            quorum_bps,
            staking_pool: None,
            min_stake_to_submit: 0,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::LastProposalId, &0u32);
    }

    /// Submits a new milestone approval proposal referencing an IPFS evidence hash.
    pub fn submit_proposal(
        env: Env,
        proposer: Address,
        milestone_id: u32,
        evidence_hash: Bytes,
    ) -> u32 {
        proposer.require_auth();

        let config = Self::get_config(env.clone());
        if proposer == config.guardian {
            panic!("Guardian cannot create proposals");
        }
        if !config.signers.contains(&proposer) {
            panic!("Address is not a registered signer");
        }

        // A configured minimum stake makes spam or nuisance proposals
        // costly: once `min_stake_to_submit` is above `0` (the deployment
        // default, which leaves the check off), a proposer must hold at
        // least that much in the configured StakingPool to submit. Raising
        // or lowering the minimum only ever affects submissions made after
        // the change — proposals already on record are never re-validated.
        if config.min_stake_to_submit > 0 {
            let stake = match &config.staking_pool {
                Some(staking_pool) => Self::read_proposer_stake(&env, staking_pool, &proposer),
                None => 0,
            };
            if stake < config.min_stake_to_submit {
                panic!("Proposer stake is below the configured minimum");
            }
        }

        let last_id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LastProposalId)
            .unwrap_or(0);
        let new_id = last_id + 1;

        let proposal = Proposal {
            milestone_id,
            evidence_hash,
            vote_count: 0,
            voters: Vec::new(&env),
            status: ProposalStatus::Open,
        };

        env.storage()
            .instance()
            .set(&DataKey::Proposal(new_id), &proposal);
        env.storage()
            .instance()
            .set(&DataKey::LastProposalId, &new_id);

        // Freeze delegation as it stands now, so later delegate/revoke calls
        // cannot move voting power on a proposal that is already open.
        let snapshot = Self::build_power_snapshot(&env, &config);
        env.storage()
            .instance()
            .set(&DataKey::PowerSnapshot(new_id), &snapshot);

        new_id
    }

    /// Casts a vote on an open proposal. If the quorum threshold is reached, the status becomes Passed.
    pub fn vote(env: Env, signer: Address, proposal_id: u32) {
        signer.require_auth();

        let config = Self::get_config(env.clone());

        if signer == config.guardian {
            panic!("Guardian cannot vote on proposals");
        }

        // 1. Verify signer is part of the governance committee
        if !config.signers.contains(&signer) {
            panic!("Address is not a registered signer");
        }

        // 2. Load proposal
        let mut proposal = Self::get_proposal(env.clone(), proposal_id)
            .unwrap_or_else(|| panic!("Proposal not found"));

        // 3. Verify proposal is Open
        if proposal.status != ProposalStatus::Open {
            panic!("Proposal is not open for voting");
        }

        // 4. Verify signer hasn't already voted
        if proposal.voters.contains(&signer) {
            panic!("Signer has already voted on this proposal");
        }

        // 5. Record the vote, weighted by the power snapshotted when the
        // proposal was opened (own vote plus any delegations to this signer).
        let power = Self::snapshot_power(&env, proposal_id, &signer);
        if power == 0 {
            panic!("Voting power is delegated to another signer");
        }
        proposal.voters.push_back(signer);
        proposal.vote_count += power;

        // 6. Calculate required votes for quorum (using ceiling calculation)
        let signers_len = config.signers.len();
        let required_votes = (signers_len * config.quorum_bps).div_ceil(10000);

        if proposal.vote_count >= required_votes {
            proposal.status = ProposalStatus::Passed;
        }
        let passed = proposal.status == ProposalStatus::Passed;

        // Save updated proposal
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);

        // A passed proposal can never be voted on again, so its frozen
        // weights have done their job: drop the snapshot to keep it only for
        // as long as it was needed to resolve the proposal.
        if passed {
            Self::prune_power_snapshot(&env, proposal_id);
        }
    }

    /// Executes an approved proposal. Callable only by regular governance signers.
    pub fn execute_proposal(env: Env, signer: Address, proposal_id: u32) {
        signer.require_auth();

        let config = Self::get_config(env.clone());
        if signer == config.guardian {
            panic!("Guardian cannot execute proposals");
        }
        if !config.signers.contains(&signer) {
            panic!("Address is not a registered signer");
        }

        let mut proposal = Self::get_proposal(env.clone(), proposal_id)
            .unwrap_or_else(|| panic!("Proposal not found"));

        if proposal.status != ProposalStatus::Passed {
            panic!("Proposal is not approved");
        }

        proposal.status = ProposalStatus::Executed;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Executed is terminal: the proposal's snapshot is no longer needed.
        Self::prune_power_snapshot(&env, proposal_id);
    }

    /// Guardian-only: cancels an open proposal before it can be executed.
    pub fn veto(env: Env, guardian: Address, proposal_id: u32) {
        guardian.require_auth();

        let config = Self::get_config(env.clone());
        if guardian != config.guardian {
            panic!("Address is not the guardian");
        }

        let mut proposal = Self::get_proposal(env.clone(), proposal_id)
            .unwrap_or_else(|| panic!("Proposal not found"));

        if proposal.status == ProposalStatus::Executed {
            panic!("Proposal has already been executed");
        }
        if proposal.status != ProposalStatus::Open {
            panic!("Proposal is not open for voting");
        }

        proposal.status = ProposalStatus::Rejected;
        env.storage()
            .instance()
            .set(&DataKey::Proposal(proposal_id), &proposal);
        // Rejected is terminal: the proposal's snapshot is no longer needed.
        Self::prune_power_snapshot(&env, proposal_id);
    }

    /// View function returning whether the proposal has been approved (Passed).
    pub fn is_approved(env: Env, proposal_id: u32) -> bool {
        if let Some(proposal) = Self::get_proposal(env, proposal_id) {
            proposal.status == ProposalStatus::Passed
        } else {
            false
        }
    }

    /// Admin-only: Adds a new signer to the governance committee.
    pub fn add_signer(env: Env, new_signer: Address) {
        let mut config = Self::get_config(env.clone());
        config.admin.require_auth();

        if new_signer == config.guardian {
            panic!("Guardian cannot be added as a signer");
        }
        if !config.signers.contains(&new_signer) {
            config.signers.push_back(new_signer);
            env.storage().instance().set(&DataKey::Config, &config);
        }
    }

    /// Admin-only: Removes an existing signer from the governance committee.
    pub fn remove_signer(env: Env, signer_to_remove: Address) {
        let mut config = Self::get_config(env.clone());
        config.admin.require_auth();

        let mut index: Option<u32> = None;
        for i in 0..config.signers.len() {
            if config.signers.get_unchecked(i) == signer_to_remove {
                index = Some(i);
                break;
            }
        }

        if let Some(i) = index {
            config.signers.remove(i);
            env.storage().instance().set(&DataKey::Config, &config);
            // A removed signer's own delegation no longer means anything.
            env.storage()
                .instance()
                .remove(&DataKey::Delegation(signer_to_remove));
        }
    }

    /// Delegates the caller's voting power to another signer.
    ///
    /// Delegation is a single hop: a signer who holds delegations cannot
    /// delegate onward, and cannot be delegated to once they have delegated
    /// themselves. That rules out chains and cycles in one rule, keeping vote
    /// counting bounded and auditable. The delegation applies to proposals
    /// submitted after this call; proposals already open keep their snapshot.
    pub fn delegate(env: Env, delegator: Address, delegate: Address) {
        delegator.require_auth();

        let config = Self::get_config(env.clone());
        if !config.signers.contains(&delegator) {
            panic!("Address is not a registered signer");
        }
        if !config.signers.contains(&delegate) {
            panic!("Delegate is not a registered signer");
        }
        if delegator == delegate {
            panic!("Cannot delegate to self");
        }
        if Self::get_delegate(env.clone(), delegator.clone()).is_some() {
            panic!("Already delegated; revoke first");
        }
        // Delegate must not itself have delegated (delegator -> delegate -> x,
        // including the cycle delegator -> delegate -> delegator).
        if Self::get_delegate(env.clone(), delegate.clone()).is_some() {
            panic!("Delegation cycle or chain not allowed");
        }
        // Delegator must not hold delegations of its own (x -> delegator -> delegate).
        for signer in config.signers.iter() {
            if Self::get_delegate(env.clone(), signer) == Some(delegator.clone()) {
                panic!("Delegation cycle or chain not allowed");
            }
        }

        env.storage()
            .instance()
            .set(&DataKey::Delegation(delegator.clone()), &delegate);
        env.events()
            .publish((symbol_short!("delegate"), delegator), delegate);
    }

    /// Revokes the caller's delegation. Takes effect for proposals submitted
    /// afterwards; proposals already open keep the power they were opened with.
    pub fn revoke_delegation(env: Env, delegator: Address) {
        delegator.require_auth();

        let delegate = Self::get_delegate(env.clone(), delegator.clone())
            .unwrap_or_else(|| panic!("No active delegation"));
        env.storage()
            .instance()
            .remove(&DataKey::Delegation(delegator.clone()));
        env.events()
            .publish((symbol_short!("revoke"), delegator), delegate);
    }

    /// The signer `delegator` currently delegates to, if any.
    pub fn get_delegate(env: Env, delegator: Address) -> Option<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Delegation(delegator))
    }

    /// Voting power `signer` holds on `proposal_id`, as frozen when the
    /// proposal was submitted.
    pub fn get_voting_power(env: Env, proposal_id: u32, signer: Address) -> u32 {
        Self::snapshot_power(&env, proposal_id, &signer)
    }

    /// Power per signer from the current delegations: a signer who has
    /// delegated to a valid signer holds 0, and the delegate gains 1 for each
    /// delegator. Delegations involving an address that is no longer a signer
    /// are ignored, leaving the delegator with their own vote.
    fn build_power_snapshot(env: &Env, config: &GovernanceConfig) -> Map<Address, u32> {
        let mut power: Map<Address, u32> = Map::new(env);
        for signer in config.signers.iter() {
            power.set(signer, 1);
        }
        for signer in config.signers.iter() {
            let delegate: Option<Address> = env
                .storage()
                .instance()
                .get(&DataKey::Delegation(signer.clone()));
            if let Some(delegate) = delegate {
                if config.signers.contains(&delegate) {
                    power.set(signer, 0);
                    let current = power.get(delegate.clone()).unwrap_or(0);
                    power.set(delegate, current + 1);
                }
            }
        }
        power
    }

    /// Snapshotted power for `signer`. Proposals without a snapshot (created
    /// before delegation existed) and signers added after the snapshot keep
    /// the original one-signer-one-vote weight.
    fn snapshot_power(env: &Env, proposal_id: u32, signer: &Address) -> u32 {
        let snapshot: Option<Map<Address, u32>> = env
            .storage()
            .instance()
            .get(&DataKey::PowerSnapshot(proposal_id));
        match snapshot {
            Some(map) => map.get(signer.clone()).unwrap_or(1),
            None => 1,
        }
    }

    /// Drops a proposal's frozen power snapshot. Called once the proposal
    /// leaves `Open` for good, so snapshots are retained only for as long as
    /// they are needed to resolve a proposal.
    fn prune_power_snapshot(env: &Env, proposal_id: u32) {
        env.storage()
            .instance()
            .remove(&DataKey::PowerSnapshot(proposal_id));
    }

    /// View function to fetch the current governance configuration.
    pub fn get_config(env: Env) -> GovernanceConfig {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("Contract not initialized"))
    }

    /// View function to retrieve a proposal's details.
    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<Proposal> {
        env.storage()
            .instance()
            .get(&DataKey::Proposal(proposal_id))
    }

    /// Admin-only: sets the StakingPool contract address used to resolve a
    /// proposer's stake at submission time.
    pub fn set_staking_pool(env: Env, admin: Address, staking_pool: Address) {
        let mut config = Self::get_config(env.clone());
        admin.require_auth();
        if admin != config.admin {
            panic!("Address is not the admin");
        }
        config.staking_pool = Some(staking_pool);
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// View function returning the configured StakingPool address, if any.
    pub fn get_staking_pool(env: Env) -> Option<Address> {
        Self::get_config(env).staking_pool
    }

    /// Admin-only: sets the minimum stake a proposer must hold to submit a
    /// new proposal. `0` disables the check. Only submissions made after
    /// this call are affected — proposals already submitted keep whatever
    /// decision was made under the previous minimum.
    pub fn set_min_stake_to_submit(env: Env, admin: Address, min_stake: i128) {
        let mut config = Self::get_config(env.clone());
        admin.require_auth();
        if admin != config.admin {
            panic!("Address is not the admin");
        }
        if min_stake < 0 {
            panic!("Minimum stake cannot be negative");
        }
        config.min_stake_to_submit = min_stake;
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// View function returning the configured minimum stake to submit.
    pub fn get_min_stake_to_submit(env: Env) -> i128 {
        Self::get_config(env).min_stake_to_submit
    }

    /// Cross-contract call to `<staking_pool>.get_shares(proposer)`, mirroring
    /// the typed StakingPool client call via raw `env.try_invoke_contract` so
    /// this crate never depends on the staking-pool crate directly (the same
    /// pattern the lending-pool contract uses for its own cross-contract
    /// calls). Returns `0` on any invocation or application error, which — on
    /// the `stake < min_stake_to_submit` comparison in `submit_proposal` —
    /// fails closed rather than silently waiving the check.
    fn read_proposer_stake(env: &Env, staking_pool: &Address, proposer: &Address) -> i128 {
        let args = soroban_sdk::vec![env, proposer.into_val(env)];
        match env.try_invoke_contract::<i128, soroban_sdk::Error>(
            staking_pool,
            &Symbol::new(env, "get_shares"),
            args,
        ) {
            Ok(Ok(shares)) => shares,
            _ => 0,
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env, Vec};

    #[test]
    fn test_initialize_and_config() {
        let env = Env::default();
        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());

        client.initialize(&admin, &guardian, &signers, &5000);

        let config = client.get_config();
        assert_eq!(config.admin, admin);
        assert_eq!(config.guardian, guardian);
        assert_eq!(config.quorum_bps, 5000);
        assert_eq!(config.signers.len(), 2);
    }

    #[test]
    fn test_proposal_submission_and_voting_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());
        signers.push_back(signer3.clone());

        // 6000 bps = 60% quorum. 3 * 0.6 = 1.8 -> ceil is 2 votes.
        client.initialize(&admin, &guardian, &signers, &6000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash1234567890");
        let proposal_id = client.submit_proposal(&signer1, &42, &evidence_hash);
        assert_eq!(proposal_id, 1);

        // Verify proposal is initially Open and not approved
        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.milestone_id, 42);
        assert_eq!(proposal.vote_count, 0);
        assert_eq!(proposal.status, ProposalStatus::Open);
        assert_eq!(client.is_approved(&proposal_id), false);

        // Signer 1 votes
        client.vote(&signer1, &proposal_id);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.vote_count, 1);
        assert_eq!(proposal.status, ProposalStatus::Open);
        assert_eq!(client.is_approved(&proposal_id), false);

        // Signer 2 votes (Quorum reached) -> proposal passes
        client.vote(&signer2, &proposal_id);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.vote_count, 2);
        assert_eq!(proposal.status, ProposalStatus::Passed);
        assert_eq!(client.is_approved(&proposal_id), true);
    }

    #[test]
    #[should_panic(expected = "Signer has already voted on this proposal")]
    fn test_double_voting_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());

        client.initialize(&admin, &guardian, &signers, &10000); // Requires 2 votes to pass

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);

        client.vote(&signer1, &proposal_id);
        client.vote(&signer1, &proposal_id); // Should panic here with already voted
    }

    #[test]
    #[should_panic(expected = "Address is not a registered signer")]
    fn test_non_signer_voting_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let non_signer = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);

        client.vote(&non_signer, &proposal_id); // Should panic here
    }

    #[test]
    fn test_signer_management() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &5000);

        // Add signer2
        client.add_signer(&signer2);
        let config = client.get_config();
        assert_eq!(config.signers.len(), 2);
        assert_eq!(config.signers.get_unchecked(1), signer2);

        // Remove signer1
        client.remove_signer(&signer1);
        let config = client.get_config();
        assert_eq!(config.signers.len(), 1);
        assert_eq!(config.signers.get_unchecked(0), signer2);
    }

    #[test]
    fn test_guardian_can_veto_pending_proposal() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);

        client.veto(&guardian, &proposal_id);
        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Rejected);
        assert_eq!(client.is_approved(&proposal_id), false);
    }

    #[test]
    #[should_panic(expected = "Address is not the guardian")]
    fn test_non_guardian_cannot_veto() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);

        client.veto(&signer1, &proposal_id);
    }

    #[test]
    #[should_panic(expected = "Guardian cannot create proposals")]
    fn test_guardian_cannot_create_proposals() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        client.submit_proposal(&guardian, &1, &evidence_hash);
    }

    #[test]
    #[should_panic(expected = "Guardian cannot vote on proposals")]
    fn test_guardian_cannot_approve_proposals() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);

        client.vote(&guardian, &proposal_id);
    }

    #[test]
    #[should_panic(expected = "Guardian cannot execute proposals")]
    fn test_guardian_cannot_execute_proposals() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);
        client.vote(&signer1, &proposal_id);
        client.vote(&signer2, &proposal_id);

        client.execute_proposal(&guardian, &proposal_id);
    }

    #[test]
    #[should_panic(expected = "Proposal is not approved")]
    fn test_vetoed_proposal_cannot_execute() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);
        client.veto(&guardian, &proposal_id);

        client.execute_proposal(&signer1, &proposal_id);
    }

    #[test]
    fn test_governance_normal_behavior_remains_unchanged() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());
        signers.push_back(signer3.clone());

        client.initialize(&admin, &guardian, &signers, &6000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash1234567890");
        let proposal_id = client.submit_proposal(&signer1, &42, &evidence_hash);
        client.vote(&signer1, &proposal_id);
        client.vote(&signer2, &proposal_id);

        let proposal = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(proposal.status, ProposalStatus::Passed);
        assert!(client.is_approved(&proposal_id));

        client.execute_proposal(&signer3, &proposal_id);
        let executed = client.get_proposal(&proposal_id).unwrap();
        assert_eq!(executed.status, ProposalStatus::Executed);
    }

    /// Minimal mock of the StakingPool contract's `get_shares` view, used to
    /// test the minimum-stake gate on `submit_proposal` without depending on
    /// the real staking-pool crate (same reasoning as the lending-pool's own
    /// cross-contract mocks).
    mod mock_staking_pool {
        use super::*;

        #[contract]
        pub struct MockStakingPool;

        #[contractimpl]
        impl MockStakingPool {
            pub fn set_shares(env: Env, staker: Address, shares: i128) {
                env.storage().instance().set(&staker, &shares);
            }

            pub fn get_shares(env: Env, staker: Address) -> i128 {
                env.storage().instance().get(&staker).unwrap_or(0)
            }
        }
    }
    use mock_staking_pool::{MockStakingPool, MockStakingPoolClient};

    #[test]
    fn test_submit_proposal_succeeds_at_or_above_min_stake() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let staking_pool_id = env.register(MockStakingPool, ());
        let staking_client = MockStakingPoolClient::new(&env, &staking_pool_id);
        staking_client.set_shares(&signer1, &1_000i128);

        client.set_staking_pool(&admin, &staking_pool_id);
        client.set_min_stake_to_submit(&admin, &1_000i128);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);
        assert_eq!(proposal_id, 1);
    }

    #[test]
    #[should_panic(expected = "Proposer stake is below the configured minimum")]
    fn test_submit_proposal_reverts_below_min_stake() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let staking_pool_id = env.register(MockStakingPool, ());
        let staking_client = MockStakingPoolClient::new(&env, &staking_pool_id);
        staking_client.set_shares(&signer1, &500i128);

        client.set_staking_pool(&admin, &staking_pool_id);
        client.set_min_stake_to_submit(&admin, &1_000i128);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        client.submit_proposal(&signer1, &1, &evidence_hash);
    }

    #[test]
    fn test_min_stake_change_only_affects_subsequent_submissions() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        let staking_pool_id = env.register(MockStakingPool, ());
        let staking_client = MockStakingPoolClient::new(&env, &staking_pool_id);
        staking_client.set_shares(&signer1, &500i128);
        client.set_staking_pool(&admin, &staking_pool_id);

        // No minimum configured yet: submission succeeds with only 500 staked.
        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash1");
        let first_id = client.submit_proposal(&signer1, &1, &evidence_hash);
        assert_eq!(first_id, 1);

        // Raise the minimum above the signer's stake. The proposal already
        // on record is untouched...
        client.set_min_stake_to_submit(&admin, &1_000i128);
        let first_proposal = client.get_proposal(&first_id).unwrap();
        assert_eq!(first_proposal.status, ProposalStatus::Open);

        // ...but a *new* submission from the same under-staked signer now reverts.
        let evidence_hash_2 = Bytes::from_slice(&env, b"QmEvidenceHash2");
        let result = client.try_submit_proposal(&signer1, &2, &evidence_hash_2);
        assert!(result.is_err());
    }

    #[test]
    fn test_min_stake_check_disabled_by_default() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let guardian = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &guardian, &signers, &10000);

        // No staking pool and no minimum configured: existing permissionless
        // behavior is preserved.
        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&signer1, &1, &evidence_hash);
        assert_eq!(proposal_id, 1);
    }

    // ── Vote delegation ──────────────────────────────────────────────────

    /// Five signers, 60% quorum (3 votes). Returns the client plus signers.
    fn delegation_setup(env: &Env) -> (GovernanceContractClient<'_>, [Address; 5]) {
        env.mock_all_auths();
        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(env, &contract_id);

        let signers_arr: [Address; 5] = core::array::from_fn(|_| Address::generate(env));
        let mut signers = Vec::new(env);
        for s in signers_arr.iter() {
            signers.push_back(s.clone());
        }
        client.initialize(
            &Address::generate(env),
            &Address::generate(env),
            &signers,
            &6000,
        );
        (client, signers_arr)
    }

    fn submit(env: &Env, client: &GovernanceContractClient<'_>, by: &Address) -> u32 {
        client.submit_proposal(by, &1, &Bytes::from_slice(env, b"QmEvidence"))
    }

    fn has_event(env: &Env, name: &str) -> bool {
        use soroban_sdk::{testutils::Events, Symbol, TryFromVal};
        env.events().all().iter().any(|(_, topics, _)| {
            topics
                .get(0)
                .and_then(|t| Symbol::try_from_val(env, &t).ok())
                == Some(Symbol::new(env, name))
        })
    }

    #[test]
    fn test_delegate_vote_carries_delegator_power() {
        let env = Env::default();
        let (client, [s1, s2, s3, _s4, _s5]) = delegation_setup(&env);

        client.delegate(&s2, &s1);
        assert!(has_event(&env, "delegate"));
        assert_eq!(client.get_delegate(&s2), Some(s1.clone()));

        let id = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&id, &s1), 2);
        assert_eq!(client.get_voting_power(&id, &s2), 0);

        // s1 alone carries s2's power: 2 of the 3 required votes.
        client.vote(&s1, &id);
        let proposal = client.get_proposal(&id).unwrap();
        assert_eq!(proposal.vote_count, 2);
        assert_eq!(proposal.status, ProposalStatus::Open);

        client.vote(&s3, &id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Passed
        );
    }

    #[test]
    #[should_panic(expected = "Voting power is delegated to another signer")]
    fn test_delegator_cannot_vote_directly() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);

        client.delegate(&s2, &s1);
        let id = submit(&env, &client, &s1);
        client.vote(&s2, &id);
    }

    #[test]
    fn test_revocation_before_proposal_opens_restores_direct_vote() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);

        client.delegate(&s2, &s1);
        client.revoke_delegation(&s2);
        assert!(has_event(&env, "revoke"));
        assert_eq!(client.get_delegate(&s2), None);

        let id = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&id, &s1), 1);
        assert_eq!(client.get_voting_power(&id, &s2), 1);

        client.vote(&s2, &id);
        assert_eq!(client.get_proposal(&id).unwrap().vote_count, 1);
    }

    #[test]
    fn test_revocation_after_proposal_opens_applies_to_next_proposal_only() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);

        client.delegate(&s2, &s1);
        let open = submit(&env, &client, &s1);

        // Revoking mid-vote cannot hand s2 a second vote on the open proposal.
        client.revoke_delegation(&s2);
        assert_eq!(client.get_voting_power(&open, &s1), 2);
        assert_eq!(client.get_voting_power(&open, &s2), 0);
        assert!(client.try_vote(&s2, &open).is_err());
        client.vote(&s1, &open);
        assert_eq!(client.get_proposal(&open).unwrap().vote_count, 2);

        // The next proposal reflects the revocation.
        let next = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&next, &s1), 1);
        assert_eq!(client.get_voting_power(&next, &s2), 1);
    }

    #[test]
    fn test_delegating_after_proposal_opens_does_not_move_power() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);

        let id = submit(&env, &client, &s1);
        client.delegate(&s2, &s1);

        // s2 keeps their own vote and s1 gains nothing on this proposal.
        assert_eq!(client.get_voting_power(&id, &s1), 1);
        assert_eq!(client.get_voting_power(&id, &s2), 1);
        client.vote(&s2, &id);
        client.vote(&s1, &id);
        assert_eq!(client.get_proposal(&id).unwrap().vote_count, 2);
    }

    #[test]
    fn test_delegation_cycles_and_chains_are_rejected() {
        let env = Env::default();
        let (client, [s1, s2, s3, ..]) = delegation_setup(&env);

        // Self-delegation.
        assert!(client.try_delegate(&s1, &s1).is_err());

        // Two-party cycle: s1 -> s2, then s2 -> s1.
        client.delegate(&s1, &s2);
        assert!(client.try_delegate(&s2, &s1).is_err());

        // Chain, delegate already delegating onward: s3 -> s1 (s1 -> s2).
        assert!(client.try_delegate(&s3, &s1).is_err());

        // Chain, delegator already holding delegations: s2 -> s3 (s1 -> s2).
        assert!(client.try_delegate(&s2, &s3).is_err());

        // The single valid hop is untouched.
        assert_eq!(client.get_delegate(&s1), Some(s2.clone()));
        assert_eq!(client.get_delegate(&s2), None);

        // Re-delegating without revoking first is rejected.
        assert!(client.try_delegate(&s1, &s3).is_err());
    }

    #[test]
    fn test_delegation_requires_registered_signers_and_active_delegation_to_revoke() {
        let env = Env::default();
        let (client, [s1, ..]) = delegation_setup(&env);
        let outsider = Address::generate(&env);

        assert!(client.try_delegate(&outsider, &s1).is_err());
        assert!(client.try_delegate(&s1, &outsider).is_err());
        assert!(client.try_revoke_delegation(&s1).is_err());
    }

    #[test]
    fn test_delegation_to_removed_signer_is_ignored_at_snapshot() {
        let env = Env::default();
        let (client, [s1, s2, s3, ..]) = delegation_setup(&env);

        client.delegate(&s2, &s3);
        client.remove_signer(&s3);

        // s2's delegate is gone, so s2 keeps their own vote.
        let id = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&id, &s2), 1);
    }

    // ── Balance-weighted vote snapshots ──────────────────────────────────

    /// A change to a signer's weight *after* a proposal opens must not move
    /// that proposal's vote weight, nor its outcome.
    #[test]
    fn test_weight_change_after_proposal_opens_does_not_affect_that_proposal() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);

        // Open the proposal first, freezing each signer at one vote.
        let id = submit(&env, &client, &s1);

        // Shift weight around *after* the snapshot: s2 hands its vote to s1.
        client.delegate(&s2, &s1);

        // The open proposal still sees the weights frozen when it opened.
        assert_eq!(client.get_voting_power(&id, &s1), 1);
        assert_eq!(client.get_voting_power(&id, &s2), 1);

        // And the outcome is decided on those frozen weights: s1 + s2 = 2,
        // one short of the 3 votes the 60% quorum requires, so it stays Open.
        client.vote(&s1, &id);
        client.vote(&s2, &id);
        let proposal = client.get_proposal(&id).unwrap();
        assert_eq!(proposal.vote_count, 2);
        assert_eq!(proposal.status, ProposalStatus::Open);
    }

    /// A proposal opened after a weight change captures a fresh snapshot,
    /// while any earlier proposal keeps the one it opened with.
    #[test]
    fn test_new_proposal_takes_a_fresh_snapshot() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);

        // First proposal opens before any delegation: one vote each.
        let first = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&first, &s1), 1);
        assert_eq!(client.get_voting_power(&first, &s2), 1);

        // s2 delegates after the first proposal opened...
        client.delegate(&s2, &s1);

        // ...the open proposal keeps its original snapshot...
        assert_eq!(client.get_voting_power(&first, &s1), 1);
        assert_eq!(client.get_voting_power(&first, &s2), 1);

        // ...but a *new* proposal snapshots the current weights.
        let second = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&second, &s1), 2);
        assert_eq!(client.get_voting_power(&second, &s2), 0);
    }

    /// Once a proposal passes (and is executed), its snapshot is pruned: the
    /// view falls back to one vote each rather than the frozen weights.
    #[test]
    fn test_snapshot_is_pruned_when_a_proposal_passes_and_executes() {
        let env = Env::default();
        let (client, [s1, s2, s3, ..]) = delegation_setup(&env);

        // A non-trivial snapshot: s1 = 2, s2 = 0.
        client.delegate(&s2, &s1);
        let id = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&id, &s1), 2);
        assert_eq!(client.get_voting_power(&id, &s2), 0);

        // Reach quorum: s1 (2) + s3 (1) = 3 of 3 -> Passed.
        client.vote(&s1, &id);
        client.vote(&s3, &id);
        let proposal = client.get_proposal(&id).unwrap();
        assert_eq!(proposal.vote_count, 3);
        assert_eq!(proposal.status, ProposalStatus::Passed);

        // The frozen weights are gone as soon as the outcome is decided.
        assert_eq!(client.get_voting_power(&id, &s1), 1);
        assert_eq!(client.get_voting_power(&id, &s2), 1);

        // Executing is terminal and leaves the snapshot pruned.
        client.execute_proposal(&s3, &id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Executed
        );
        assert_eq!(client.get_voting_power(&id, &s1), 1);
    }

    /// A vetoed (rejected) proposal also has its snapshot pruned.
    #[test]
    fn test_snapshot_is_pruned_when_a_proposal_is_vetoed() {
        let env = Env::default();
        let (client, [s1, s2, ..]) = delegation_setup(&env);
        let guardian = client.get_config().guardian;

        client.delegate(&s2, &s1);
        let id = submit(&env, &client, &s1);
        assert_eq!(client.get_voting_power(&id, &s1), 2);

        client.veto(&guardian, &id);
        assert_eq!(
            client.get_proposal(&id).unwrap().status,
            ProposalStatus::Rejected
        );
        assert_eq!(client.get_voting_power(&id, &s1), 1);
        assert_eq!(client.get_voting_power(&id, &s2), 1);
    }
}
