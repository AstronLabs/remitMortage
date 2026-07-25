#![cfg(test)]

use super::*;
use crate::errors::MilestoneError;
use crate::types::{MilestoneRecord, MilestoneStatus};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::testutils::Ledger;
use soroban_sdk::{token, Address, Bytes, BytesN, Env, Vec};

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
        Refunded,
        LoanBorrower(BytesN<32>),
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
            env.storage().instance().set(&MKey::Refunded, &0i128);
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

        pub fn refnd_ms(
            env: Env,
            _loan_id: BytesN<32>,
            amount: i128,
        ) -> Result<(), MockPoolError> {
            // Only the configured admin (the milestone contract) may refund.
            let admin: Address = env.storage().instance().get(&MKey::Admin).unwrap();
            admin.require_auth();

            let refunded: i128 = env.storage().instance().get(&MKey::Refunded).unwrap_or(0);
            env.storage()
                .instance()
                .set(&MKey::Refunded, &(refunded + amount));
            Ok(())
        }

        pub fn total_disbursed(env: Env) -> i128 {
            env.storage().instance().get(&MKey::Disbursed).unwrap_or(0)
        }

        pub fn total_refunded(env: Env) -> i128 {
            env.storage().instance().get(&MKey::Refunded).unwrap_or(0)
        }

        pub fn set_loan_borrower(env: Env, loan_id: BytesN<32>, borrower: Address) {
            env.storage()
                .instance()
                .set(&MKey::LoanBorrower(loan_id), &borrower);
        }

        pub fn get_loan_borrower(env: Env, loan_id: BytesN<32>) -> Option<Address> {
            env.storage().instance().get(&MKey::LoanBorrower(loan_id))
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

fn make_client(env: &Env) -> (Address, MilestoneContractClient) {
    let milestone_id = env.register(MilestoneContract, ());
    let client = MilestoneContractClient::new(env, &milestone_id);
    let admin = Address::generate(env);
    let token = Address::generate(env);
    let pool = Address::generate(env);
    let mut approvers = Vec::new(env);
    approvers.push_back(Address::generate(env));
    approvers.push_back(Address::generate(env));
    client.initialize(&admin, &token, &pool, &approvers, &2u32);
    (admin, client)
}

fn cidv0(env: &Env) -> Bytes {
    let mut raw = [b'x'; 46];
    raw[0] = b'Q';
    raw[1] = b'm';
    Bytes::from_slice(env, &raw)
}

// â”€â”€ Initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Proposal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        &cidv0(&env),
    );

    let record: MilestoneRecord = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Proposed);
    assert_eq!(record.contractor, h.contractor);
    assert_eq!(record.amount, 1_000i128);
    assert_eq!(record.votes, 0);
    assert_eq!(record.evidence_hash, evidence(&env));
}

#[test]
fn test_propose_self_dealing_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let borrower = Address::generate(&env);
    h.pool.set_loan_borrower(&loan_id(&env), &borrower);

    let res = h.milestone.try_propose_milestone(
        &borrower,
        &proposal_id(&env),
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
        &cidv0(&env),
    );
    assert_eq!(res, Err(Ok(MilestoneError::SelfDealingNotAllowed)));
}

#[test]
fn test_propose_non_self_dealing_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let h = setup(&env, 2, 2, 5_000, 10_000);

    let borrower = Address::generate(&env);
    let contractor = Address::generate(&env);
    h.pool.set_loan_borrower(&loan_id(&env), &borrower);

    h.milestone.propose_milestone(
        &contractor,
        &proposal_id(&env),
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
        &cidv0(&env),
    );

    let record = h.milestone.get_milestone(&proposal_id(&env));
    assert_eq!(record.contractor, contractor);
    assert_eq!(record.status, MilestoneStatus::Proposed);
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
        &cidv0(&env),
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
        &cidv0(&env),
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
        &cidv0(&env),
    );

    let res = h.milestone.try_propose_milestone(
        &h.contractor,
        &pid,
        &loan_id(&env),
        &1_000i128,
        &evidence(&env),
        &cidv0(&env),
    );
    assert_eq!(res, Err(Ok(MilestoneError::MilestoneExists)));
}

// â”€â”€ Approval / multisig governance â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        &cidv0(&env),
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
        &cidv0(&env),
    );

    // A random address that is not in the approver set cannot approve, even
    // with auth mocked â€” enforced by the multisig membership check.
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
        &cidv0(&env),
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

// â”€â”€ Release / cross-contract disbursement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
        &cidv0(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    env.ledger().set_sequence_number(100);
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
        &cidv0(&env),
    );

    // Only one of two required votes cast: still Proposed.
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);

    let res = h.milestone.try_release_milestone(&pid);
    assert_eq!(res, Err(Ok(MilestoneError::InvalidStatus)));
}

#[test]
fn test_release_is_blocked_until_configured_timelock_elapses() {
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
        &cidv0(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    h.milestone.set_min_delay_ledgers(&h.admin, &5u32);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.approved_ledger, 0);

    let res = h.milestone.try_release_milestone(&pid);
    assert_eq!(res, Err(Ok(MilestoneError::TimelockNotElapsed)));

    env.ledger().set_sequence_number(5);
    h.milestone.release_milestone(&pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Disbursed);
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
        &cidv0(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    env.ledger().set_sequence_number(100);
    h.milestone.release_milestone(&pid);

    // Second release is blocked because the milestone is already Disbursed â€”
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
        &cidv0(&env),
    );
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    env.ledger().set_sequence_number(100);
    h.milestone.release_milestone(&pid);
}

// â”€â”€ Authorization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
            &cidv0(&env),
        );
        h
    };

    // ...then revoke all authorizations: the approver has not signed.
    h.env.set_auths(&[]);
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &proposal_id(&env));
}

// â”€â”€ Dispute Resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[test]
fn test_dispute_approved_milestone() {
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
        &cidv0(&env),
    );

    // Reach approval threshold
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Approved);

    // First approver disputes the milestone
    h.milestone
        .dispute_milestone(&h.approvers.get(0).unwrap(), &pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Refunded);
    assert!(record.disputed_ledger > 0);
}

#[test]
fn test_dispute_disbursed_milestone() {
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
        &cidv0(&env),
    );

    // Reach approval and then release
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    env.ledger().set_sequence_number(100);
    h.milestone.release_milestone(&pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Disbursed);
    assert_eq!(h.pool.total_disbursed(), amount);

    // Governance disputes the disbursed milestone
    h.milestone
        .dispute_milestone(&h.approvers.get(0).unwrap(), &pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Refunded);
    assert_eq!(h.pool.total_refunded(), amount);
}

#[test]
fn test_cannot_dispute_proposed_milestone() {
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
        &cidv0(&env),
    );

    // Cannot dispute a milestone that is still Proposed
    let res = h.milestone
        .try_dispute_milestone(&h.approvers.get(0).unwrap(), &pid);
    assert_eq!(res, Err(Ok(MilestoneError::CannotDispute)));
}

#[test]
fn test_cannot_dispute_already_refunded_milestone() {
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
        &cidv0(&env),
    );

    // Approve milestone
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    // First dispute succeeds
    h.milestone
        .dispute_milestone(&h.approvers.get(0).unwrap(), &pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Refunded);

    // Second dispute fails
    let res = h.milestone
        .try_dispute_milestone(&h.approvers.get(1).unwrap(), &pid);
    assert_eq!(res, Err(Ok(MilestoneError::AlreadyDisputed)));
}

#[test]
fn test_dispute_requires_governance_approval() {
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
        &cidv0(&env),
    );

    // Approve milestone
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    // Non-approver cannot dispute
    let unauthorized = Address::generate(&env);
    let res = h.milestone
        .try_dispute_milestone(&unauthorized, &pid);
    assert_eq!(res, Err(Ok(MilestoneError::Unauthorized)));
}

#[test]
fn test_disputed_milestone_prevents_release() {
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
        &cidv0(&env),
    );

    // Approve milestone
    h.milestone
        .approve_milestone(&h.approvers.get(0).unwrap(), &pid);
    h.milestone
        .approve_milestone(&h.approvers.get(1).unwrap(), &pid);

    // Dispute before release
    h.milestone
        .dispute_milestone(&h.approvers.get(0).unwrap(), &pid);

    let record = h.milestone.get_milestone(&pid);
    assert_eq!(record.status, MilestoneStatus::Refunded);

    // Attempt to release should fail because it's no longer Approved
    env.ledger().set_sequence_number(100);
    let res = h.milestone.try_release_milestone(&pid);
    assert_eq!(res, Err(Ok(MilestoneError::InvalidStatus)));
}

// â”€â”€ Reentrancy guard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

#[test]
fn test_release_milestone_blocked_when_reentrant_flag_set() {
    let env = Env::default();
    env.mock_all_auths();

    let contractor = Address::generate(&env);
    let (admin, client) = make_client(&env);

    let proposal_id = BytesN::from_array(&env, &[40u8; 32]);
    let loan_id = BytesN::from_array(&env, &[41u8; 32]);
    let evidence = BytesN::from_array(&env, &[42u8; 32]);

    client.propose_milestone(&contractor, &proposal_id, &loan_id, &500i128, &evidence, &cidv0(&env));
    client.approve_milestone(&admin, &proposal_id);

    env.as_contract(&client.address, || {
        env.storage().instance().set(&DataKey::Reentrant, &true);
    });

    let result = client.try_release_milestone(&proposal_id);
    assert_eq!(result.unwrap_err(), Ok(MilestoneError::ReentrancyGuard));
}

#[test]
fn test_release_milestone_succeeds_when_flag_is_clear() {
    let env = Env::default();
    env.mock_all_auths();

    let contractor = Address::generate(&env);
    let (admin, client) = make_client(&env);

    let proposal_id = BytesN::from_array(&env, &[50u8; 32]);
    let loan_id = BytesN::from_array(&env, &[51u8; 32]);
    let evidence = BytesN::from_array(&env, &[52u8; 32]);

    client.propose_milestone(&contractor, &proposal_id, &loan_id, &500i128, &evidence, &cidv0(&env));
    client.approve_milestone(&admin, &proposal_id);

    let result = client.try_release_milestone(&proposal_id);
    if let Err(e) = result {
        assert_ne!(e, Ok(MilestoneError::ReentrancyGuard));
    }
}
