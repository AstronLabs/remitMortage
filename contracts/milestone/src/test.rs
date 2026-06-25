#![cfg(test)]

use super::*;
use crate::errors::MilestoneError;
use crate::types::{MilestoneRecord, MilestoneStatus};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::{token, Address, BytesN, Env, Vec};

/// Minimal mock of the lending pool exposing the same `disburse` ABI the
/// milestone contract calls cross-contract. It actually moves tokens (so the
/// token transfer is exercised) and enforces a cap to mimic the real pool's
/// principal limit.
mod mockpool {
    use soroban_sdk::{
        contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env,
    };

    #[contracterror]
    #[derive(Copy, Clone, Debug, Eq, PartialEq)]
    #[repr(u32)]
    pub enum MockPoolError {
        ExceedsCap = 1,
    }

    #[contracttype]
    pub enum MKey {
        Admin,
        Token,
        Cap,
        Disbursed,
    }

    #[contract]
    pub struct MockLendingPool;

    #[contractimpl]
    impl MockLendingPool {
        pub fn initialize(env: Env, admin: Address, token: Address, cap: i128) {
            env.storage().instance().set(&MKey::Admin, &admin);
            env.storage().instance().set(&MKey::Token, &token);
            env.storage().instance().set(&MKey::Cap, &cap);
            env.storage().instance().set(&MKey::Disbursed, &0i128);
        }

        pub fn disburse(
            env: Env,
            _loan_id: BytesN<32>,
            recipient: Address,
            amount: i128,
        ) -> Result<(), MockPoolError> {
            // Only the configured admin (the milestone contract) may disburse.
            let admin: Address = env.storage().instance().get(&MKey::Admin).unwrap();
            admin.require_auth();

            let cap: i128 = env.storage().instance().get(&MKey::Cap).unwrap();
            if amount > cap {
                return Err(MockPoolError::ExceedsCap);
            }

            let token_addr: Address = env.storage().instance().get(&MKey::Token).unwrap();
            token::Client::new(&env, &token_addr).transfer(
                &env.current_contract_address(),
                &recipient,
                &amount,
            );

            let disbursed: i128 = env.storage().instance().get(&MKey::Disbursed).unwrap_or(0);
            env.storage()
                .instance()
                .set(&MKey::Disbursed, &(disbursed + amount));
            Ok(())
        }

        pub fn total_disbursed(env: Env) -> i128 {
            env.storage().instance().get(&MKey::Disbursed).unwrap_or(0)
        }
    }
}

struct Harness<'a> {
    env: Env,
    admin: Address,
    contractor: Address,
    approvers: Vec<Address>,
    token: Address,
    pool_id: Address,
    milestone: MilestoneContractClient<'a>,
    pool: mockpool::MockLendingPoolClient<'a>,
}

/// Wire up token + mock pool + milestone contract. The mock pool is funded
/// with `pool_funding` and its admin is the milestone contract so the
/// cross-contract `disburse` call is authorized.
fn setup(
    env: &Env,
    approver_count: u32,
    threshold: u32,
    pool_cap: i128,
    pool_funding: i128,
) -> Harness<'_> {
    let milestone_id = env.register(MilestoneContract, ());
    let milestone = MilestoneContractClient::new(env, &milestone_id);

    let pool_id = env.register(mockpool::MockLendingPool, ());
    let pool = mockpool::MockLendingPoolClient::new(env, &pool_id);

    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_id.address();
    StellarAssetClient::new(env, &token).mint(&pool_id, &pool_funding);

    pool.initialize(&milestone_id, &token, &pool_cap);

    let admin = Address::generate(env);
    let contractor = Address::generate(env);
    let mut approvers = Vec::new(env);
    for _ in 0..approver_count {
        approvers.push_back(Address::generate(env));
    }

    milestone.initialize(&admin, &token, &pool_id, &approvers, &threshold);

    Harness {
        env: env.clone(),
        admin,
        contractor,
        approvers,
        token,
        pool_id,
        milestone,
        pool,
    }
}

fn proposal_id(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[1u8; 32])
}

fn loan_id(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[2u8; 32])
}

fn evidence(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[9u8; 32])
}

// ── Initialization ──────────────────────────────────────────────────────

#[test]
fn test_initialize() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 3, 2, 1_000, 10_000);
    assert_eq!(h.milestone.version(), 1);
}

#[test]
fn test_double_initialize_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 3, 2, 1_000, 10_000);

    let res = h
        .milestone
        .try_initialize(&h.admin, &h.token, &h.pool_id, &h.approvers, &2u32);
    assert_eq!(res, Err(Ok(MilestoneError::AlreadyInitialized)));
}

#[test]
fn test_initialize_invalid_threshold_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let milestone_id = env.register(MilestoneContract, ());
    let milestone = MilestoneContractClient::new(&env, &milestone_id);

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let pool = Address::generate(&env);
    let mut approvers = Vec::new(&env);
    approvers.push_back(Address::generate(&env));

    // threshold (2) exceeds the number of approvers (1)
    let res = milestone.try_initialize(&admin, &token, &pool, &approvers, &2u32);
    assert_eq!(res, Err(Ok(MilestoneError::InvalidThreshold)));

    // threshold of zero is also invalid
    let res = milestone.try_initialize(&admin, &token, &pool, &approvers, &0u32);
    assert_eq!(res, Err(Ok(MilestoneError::InvalidThreshold)));
}

// ── Proposal ────────────────────────────────────────────────────────────

#[test]
fn test_propose_milestone_creates_record() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );

    let record: MilestoneRecord = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Proposed);
    assert_eq!(record.contractor, h.contractor);
    assert_eq!(record.amount, 1_000i128);
    assert_eq!(record.votes, 0);
    assert_eq!(record.evidence_hash, evidence(&env));
}

#[test]
fn test_propose_zero_amount_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let res = h.milestone.try_propose_milestone(
        &h.contractor,
        &proposal_id(&env),
        &loan_id(&env),
        &0i128,
        &evidence(&env),
    );
    assert_eq!(res, Err(Ok(MilestoneError::InvalidAmount)));
}

#[test]
fn test_propose_zero_evidence_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let zero = BytesN::from_array(&env, &[0u8; 32]);
    let res = h.milestone.try_propose_milestone(
        &h.contractor,
        &proposal_id(&env),
        &loan_id(&env),
        &1_000i128,
        &zero,
    );
    assert_eq!(res, Err(Ok(MilestoneError::EvidenceRequired)));
}

#[test]
fn test_propose_duplicate_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );

    let res = h.milestone.try_propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );
    assert_eq!(res, Err(Ok(MilestoneError::MilestoneExists)));
}

// ── Approval / multisig governance ────────────────────────────────────────

#[test]
fn test_approve_reaches_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 3, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );

    // First vote: still Proposed, votes == 1.
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.votes, 1);
    assert_eq!(record.status, MilestoneStatus::Proposed);

    // Second vote reaches threshold (2): Approved.
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);
    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.votes, 2);
    assert_eq!(record.status, MilestoneStatus::Approved);
}

#[test]
fn test_approve_by_non_approver_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );

    // A random address that is not in the approver set cannot approve, even
    // with auth mocked — enforced by the multisig membership check.
    let outsider = Address::generate(&env);
    let res = h.milestone.try_approve_milestone(&outsider, &pid);
    assert_eq!(res, Err(Ok(MilestoneError::Unauthorized)));
}

#[test]
fn test_approve_twice_by_same_approver_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 3, 3, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );

    let approver = h.approvers.get(0).unwrap();
    h.milestone.approve_milestone(&approver, &pid);

    let res = h.milestone.try_approve_milestone(&approver, &pid);
    assert_eq!(res, Err(Ok(MilestoneError::AlreadyVoted)));
}

#[test]
fn test_approve_unknown_milestone_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let res = h
        .milestone
        .try_approve_milestone(&h.approvers.get(0).unwrap(), &proposal_id(&env));
    assert_eq!(res, Err(Ok(MilestoneError::MilestoneNotFound)));
}

// ── Release / cross-contract disbursement ─────────────────────────────────

#[test]
fn test_release_disburses_via_cross_contract() {
    let env = Env::default();
    env.mock_all_auths();
    let amount = 1_000i128;
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &amount,
        &evidence(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    h.milestone.release_milestone(&pid);

    // Cross-contract call moved exactly `amount` from the pool to the contractor.
    let token = token::Client::new(&env, &h.token);
    assert_eq!(token.balance(&h.contractor), amount);
    assert_eq!(h.pool.total_disbursed(), amount);

    // Milestone is now Disbursed.
    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Disbursed);
}

#[test]
fn test_release_before_approved_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );

    // Only one of two required votes cast: still Proposed.
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);

    let res = h.milestone.try_release_milestone(&pid);
    assert_eq!(res, Err(Ok(MilestoneError::InvalidStatus)));
}

#[test]
fn test_cannot_release_twice() {
    let env = Env::default();
    env.mock_all_auths();
    let amount = 1_000i128;
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &amount,
        &evidence(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    h.milestone.release_milestone(&pid);

    // Second release is blocked because the milestone is already Disbursed —
    // the allocation can never be released more than once.
    let res = h.milestone.try_release_milestone(&pid);
    assert_eq!(res, Err(Ok(MilestoneError::InvalidStatus)));

    // And no extra funds left the pool.
    assert_eq!(h.pool.total_disbursed(), amount);
}

#[test]
#[should_panic]
fn test_release_exceeding_pool_cap_fails() {
    let env = Env::default();
    env.mock_all_auths();

    // Milestone amount exceeds the pool's per-disbursement cap, so the
    // cross-contract disburse traps and the release reverts.
    let h = setup(&env, 2, 2, 500, 10_000);

    let pid = proposal_id(&env);
    h.milestone.propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    h.milestone.release_milestone(&pid);
}

// ── Authorization ─────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
fn test_approve_requires_caller_auth() {
    let env = Env::default();
    let h = {
        // Initialize everything with auth mocked...
        env.mock_all_auths();
        let h = setup(&env, 2, 2, 5_000, 10_000);
        let pid = proposal_id(&env);
        h.milestone.propose_milestone(
            &h.contractor,
            &pid,
            &loan_id(&env),
            &1_000i128,
            &evidence(&env),
        );
        h
    };

    // ...then revoke all authorizations: the approver has not signed.
    h.env.set_auths(&[]);
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &proposal_id(&env));
}
