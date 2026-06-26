#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Bytes, Env, Vec};

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum ProposalStatus {
    Open,
    Passed,
    Rejected,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceConfig {
    pub admin: Address,
    pub signers: Vec<Address>,
    pub quorum_bps: u32, // Quorum in basis points, e.g. 6000 = 60%
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
}

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    /// Initializes the governance wrapper with an admin, a list of signers, and a quorum threshold.
    pub fn initialize(env: Env, admin: Address, signers: Vec<Address>, quorum_bps: u32) {
        if env.storage().instance().has(&DataKey::Config) {
            panic!("Already initialized");
        }
        if quorum_bps > 10000 {
            panic!("Quorum basis points cannot exceed 10000");
        }

        let config = GovernanceConfig {
            admin,
            signers,
            quorum_bps,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::LastProposalId, &0u32);
    }

    /// Submits a new milestone approval proposal referencing an IPFS evidence hash.
    pub fn submit_proposal(env: Env, milestone_id: u32, evidence_hash: Bytes) -> u32 {
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

        env.storage().instance().set(&DataKey::Proposal(new_id), &proposal);
        env.storage().instance().set(&DataKey::LastProposalId, &new_id);

        new_id
    }

    /// Casts a vote on an open proposal. If the quorum threshold is reached, the status becomes Passed.
    pub fn vote(env: Env, signer: Address, proposal_id: u32) {
        signer.require_auth();

        let config = Self::get_config(env.clone());

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

        // 5. Record the vote
        proposal.voters.push_back(signer);
        proposal.vote_count += 1;

        // 6. Calculate required votes for quorum (using ceiling calculation)
        let signers_len = config.signers.len();
        let required_votes = (signers_len * config.quorum_bps + 9999) / 10000;

        if proposal.vote_count >= required_votes {
            proposal.status = ProposalStatus::Passed;
        }

        // Save updated proposal
        env.storage().instance().set(&DataKey::Proposal(proposal_id), &proposal);
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
        }
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
        env.storage().instance().get(&DataKey::Proposal(proposal_id))
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
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());

        client.initialize(&admin, &signers, &5000);

        let config = client.get_config();
        assert_eq!(config.admin, admin);
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
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);
        let signer3 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());
        signers.push_back(signer2.clone());
        signers.push_back(signer3.clone());

        // 6000 bps = 60% quorum. 3 * 0.6 = 1.8 -> ceil is 2 votes.
        client.initialize(&admin, &signers, &6000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash1234567890");
        let proposal_id = client.submit_proposal(&42, &evidence_hash);
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
        let signer1 = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&1, &evidence_hash);

        client.vote(&signer1, &proposal_id);
        client.vote(&signer1, &proposal_id); // Should panic here
    }

    #[test]
    #[should_panic(expected = "Address is not a registered signer")]
    fn test_non_signer_voting_panics() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let non_signer = Address::generate(&env);
        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &signers, &10000);

        let evidence_hash = Bytes::from_slice(&env, b"QmEvidenceHash");
        let proposal_id = client.submit_proposal(&1, &evidence_hash);

        client.vote(&non_signer, &proposal_id); // Should panic here
    }

    #[test]
    fn test_signer_management() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(GovernanceContract, ());
        let client = GovernanceContractClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let signer1 = Address::generate(&env);
        let signer2 = Address::generate(&env);

        let mut signers = Vec::new(&env);
        signers.push_back(signer1.clone());

        client.initialize(&admin, &signers, &5000);

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
}
