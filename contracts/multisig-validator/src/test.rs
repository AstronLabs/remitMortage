// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    vec, Address, BytesN, Env, Vec,
};

fn key(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn signer(env: &Env, b: u8, weight: u32) -> Signer {
    Signer {
        key: key(env, b),
        weight,
    }
}

/// Register a 3-signer account with weights {A:2, B:1, C:1} and threshold 3.
fn setup(env: &Env) -> (Address, MultisigValidatorClient<'_>) {
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(env, &contract_id);

    let account = Address::generate(env);
    let signers: Vec<Signer> = vec![
        env,
        signer(env, 0xA1, 2),
        signer(env, 0xB2, 1),
        signer(env, 0xC3, 1),
    ];
    client.configure_account(&account, &signers, &3u32);
    (account, client)
}

#[test]
fn test_configure_and_read() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    assert_eq!(client.get_threshold(&account), 3u32);
    assert_eq!(client.total_weight(&account), 4u32);
    assert_eq!(client.get_config(&account).signers.len(), 3u32);
}

#[test]
fn test_meets_threshold_exactly() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    // A(2) + B(1) = 3 == threshold.
    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    assert_eq!(client.tally_weight(&account, &keys), 3u32);
    assert!(client.verify_threshold(&account, &keys));
    client.enforce_threshold(&account, &keys); // does not panic
}

#[test]
fn test_exceeds_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    // A(2) + B(1) + C(1) = 4 > 3.
    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2), key(&env, 0xC3)];
    assert_eq!(client.tally_weight(&account, &keys), 4u32);
    assert!(client.verify_threshold(&account, &keys));
}

#[test]
fn test_insufficient_weight_returns_false() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    // B(1) + C(1) = 2 < 3.
    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xB2), key(&env, 0xC3)];
    assert_eq!(client.tally_weight(&account, &keys), 2u32);
    assert!(!client.verify_threshold(&account, &keys));
}

#[test]
fn test_enforce_threshold_rejects_insufficient() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xC3)]; // weight 1 < 3
    let res = client.try_enforce_threshold(&account, &keys);
    assert_eq!(res, Err(Ok(ValidatorError::InsufficientWeight)));
}

#[test]
fn test_unknown_signer_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xFF)];
    let res = client.try_verify_threshold(&account, &keys);
    assert_eq!(res, Err(Ok(ValidatorError::UnknownSigner)));
}

#[test]
fn test_duplicate_presented_key_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    // Presenting A twice must not double-count its weight to reach 4.
    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xA1)];
    let res = client.try_tally_weight(&account, &keys);
    assert_eq!(res, Err(Ok(ValidatorError::DuplicateSigner)));
}

#[test]
fn test_threshold_above_total_weight_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    let account = Address::generate(&env);

    let signers: Vec<Signer> = vec![&env, signer(&env, 0xA1, 1), signer(&env, 0xB2, 1)];
    // threshold 3 > total weight 2.
    let res = client.try_configure_account(&account, &signers, &3u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_zero_weight_signer_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    let account = Address::generate(&env);

    let signers: Vec<Signer> = vec![&env, signer(&env, 0xA1, 0)];
    let res = client.try_configure_account(&account, &signers, &1u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidWeight)));
}

#[test]
fn test_duplicate_configured_signer_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    let account = Address::generate(&env);

    let signers: Vec<Signer> = vec![&env, signer(&env, 0xA1, 1), signer(&env, 0xA1, 2)];
    let res = client.try_configure_account(&account, &signers, &1u32);
    assert_eq!(res, Err(Ok(ValidatorError::DuplicateSigner)));
}

#[test]
fn test_unconfigured_account_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    let account = Address::generate(&env);

    let res = client.try_get_threshold(&account);
    assert_eq!(res, Err(Ok(ValidatorError::AccountNotConfigured)));
}

// ── Timelock Tests ─────────────────────────────────────────────────────────

fn proposal_id(env: &Env, b: u8) -> BytesN<32> {
    BytesN::from_array(env, &[b; 32])
}

fn setup_with_timelock(env: &Env) -> (Address, MultisigValidatorClient<'_>) {
    let (account, client) = setup(env); // 3 signers, threshold 3
    client.configure_timelock(&account, &10u64); // 10-second delay
    env.ledger().set_timestamp(1_000_000);
    (account, client)
}

#[test]
fn test_configure_timelock_and_read() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    client.configure_timelock(&account, &30u64);
    let config = client.get_timelock(&account);
    assert_eq!(config.delay_seconds, 30u64);
}

#[test]
fn test_timelock_not_configured_errors() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);

    let res = client.try_get_timelock(&account);
    assert_eq!(res, Err(Ok(ValidatorError::TimelockNotConfigured)));
}

#[test]
fn test_submit_and_get_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let (_account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xAA);

    client.submit_action(&pid, &0u32);
    let proposal = client.get_proposal(&pid);
    assert_eq!(proposal.state, ProposalState::Pending);
    assert_eq!(proposal.created_at, 1_000_000);
    // Default expiry should be set (non-zero in test = 1_000 ledgers from seq 0)
    assert!(proposal.expiration_ledger > 0);
}

#[test]
fn test_approve_transitions_to_locked() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xAA);

    client.submit_action(&pid, &0u32);

    // A(2) + B(1) = 3 >= threshold 3
    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);

    let proposal = client.get_proposal(&pid);
    assert_eq!(proposal.state, ProposalState::Locked);
    assert_eq!(proposal.ready_at, 1_000_010); // 1_000_000 + 10
}

#[test]
fn test_execute_after_timelock_elapsed() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xBB);

    client.submit_action(&pid, &0u32);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);

    // Advance past the 10-second delay.
    env.ledger().set_timestamp(1_000_011);

    client.execute_action(&pid);

    let proposal = client.get_proposal(&pid);
    assert_eq!(proposal.state, ProposalState::Executed);
}

#[test]
fn test_execute_before_timelock_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xCC);

    client.submit_action(&pid, &0u32);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);

    // Only 5 seconds have passed; delay is 10.
    env.ledger().set_timestamp(1_000_005);

    let res = client.try_execute_action(&pid);
    assert_eq!(res, Err(Ok(ValidatorError::TimelockNotElapsed)));
}

#[test]
fn test_cannot_execute_twice() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xDD);

    client.submit_action(&pid, &0u32);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);

    env.ledger().set_timestamp(1_000_011);
    client.execute_action(&pid);

    let res = client.try_execute_action(&pid);
    assert_eq!(res, Err(Ok(ValidatorError::ProposalAlreadyExecuted)));
}

#[test]
fn test_cannot_approve_executed_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xEE);

    client.submit_action(&pid, &0u32);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);
    env.ledger().set_timestamp(1_000_011);
    client.execute_action(&pid);

    let res = client.try_approve_action(&account, &pid, &keys);
    assert_eq!(res, Err(Ok(ValidatorError::ProposalAlreadyExecuted)));
}

#[test]
fn test_execute_without_approval_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0xFF);

    client.submit_action(&pid, &0u32);
    // Never approved.

    env.ledger().set_timestamp(1_000_011);
    let res = client.try_execute_action(&pid);
    assert_eq!(res, Err(Ok(ValidatorError::NotYetApproved)));
}

#[test]
fn test_can_execute_returns_correctly() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env);
    let pid = proposal_id(&env, 0x11);

    client.submit_action(&pid, &0u32);

    // Pending → can_execute false.
    assert!(!client.can_execute(&pid));

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);

    // Locked but before delay → false.
    assert!(!client.can_execute(&pid));

    // After delay → true.
    env.ledger().set_timestamp(1_000_011);
    assert!(client.can_execute(&pid));

    // Executed → false.
    client.execute_action(&pid);
    assert!(!client.can_execute(&pid));
}

#[test]
fn test_zero_delay_timelock_allows_immediate_execution() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env);
    env.ledger().set_timestamp(1_000_000);

    client.configure_timelock(&account, &0u64); // No delay.
    let pid = proposal_id(&env, 0x22);
    client.submit_action(&pid, &0u32);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &keys);

    // ready_at = 1_000_000 + 0 = 1_000_000, which is <= current time.
    assert!(client.can_execute(&pid));
    client.execute_action(&pid);
    assert_eq!(client.get_proposal(&pid).state, ProposalState::Executed);
}

#[test]
fn test_approve_action_without_timelock_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env); // No timelock configured.
    let pid = proposal_id(&env, 0x33);
    client.submit_action(&pid, &0u32);

    let keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    let res = client.try_approve_action(&account, &pid, &keys);
    assert_eq!(res, Err(Ok(ValidatorError::TimelockNotConfigured)));
}

// ── Admin-managed k-of-n signer configuration ───────────────────────────────

/// Register an admin and a 3-signer `2-of-3` admin-managed set.
fn setup_admin(env: &Env) -> (Address, Vec<Address>, MultisigValidatorClient<'_>) {
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(env, &contract_id);

    let admin = Address::generate(env);
    client.init_admin(&admin);

    let signers: Vec<Address> = vec![
        env,
        Address::generate(env),
        Address::generate(env),
        Address::generate(env),
    ];
    client.configure_signers(&signers, &2u32);
    (admin, signers, client)
}

#[test]
fn test_admin_configure_and_read() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    let config = client.get_signer_config();
    assert_eq!(config.threshold, 2u32);
    assert_eq!(config.signers.len(), 3u32);
    assert_eq!(config.signers, signers);
}

#[test]
fn test_init_admin_twice_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let res = client.try_init_admin(&Address::generate(&env));
    assert_eq!(res, Err(Ok(ValidatorError::AdminAlreadySet)));
}

#[test]
fn test_configure_signers_before_admin_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    let signers: Vec<Address> = vec![&env, Address::generate(&env)];
    let res = client.try_configure_signers(&signers, &1u32);
    assert_eq!(res, Err(Ok(ValidatorError::AdminNotSet)));
}

#[test]
fn test_configure_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    client.init_admin(&Address::generate(&env));
    let signers: Vec<Address> = vec![&env, Address::generate(&env), Address::generate(&env)];
    let res = client.try_configure_signers(&signers, &0u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_configure_rejects_threshold_over_signer_count() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    client.init_admin(&Address::generate(&env));
    let signers: Vec<Address> = vec![&env, Address::generate(&env), Address::generate(&env)];
    let res = client.try_configure_signers(&signers, &3u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_configure_rejects_duplicate_signers() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);
    client.init_admin(&Address::generate(&env));
    let dup = Address::generate(&env);
    let signers: Vec<Address> = vec![&env, dup.clone(), dup];
    let res = client.try_configure_signers(&signers, &1u32);
    assert_eq!(res, Err(Ok(ValidatorError::SignerAlreadyExists)));
}

#[test]
fn test_set_threshold_success() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    client.set_threshold(&3u32);
    assert_eq!(client.get_signer_config().threshold, 3u32);
}

#[test]
fn test_set_threshold_rejects_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let res = client.try_set_threshold(&0u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_set_threshold_rejects_over_signer_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let res = client.try_set_threshold(&4u32); // only 3 signers.
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_add_signer_success() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let new_signer = Address::generate(&env);
    client.add_signer(&new_signer);

    let config = client.get_signer_config();
    assert_eq!(config.signers.len(), 4u32);
    assert!(config.signers.contains(&new_signer));
}

#[test]
fn test_add_duplicate_signer_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);
    let res = client.try_add_signer(&signers.get_unchecked(0));
    assert_eq!(res, Err(Ok(ValidatorError::SignerAlreadyExists)));
}

#[test]
fn test_remove_signer_below_threshold_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);
    // 3 signers, threshold 2. Removing one -> 2 signers (ok).
    client.remove_signer(&signers.get_unchecked(2));
    // Now 2 signers, threshold 2. Removing another -> 1 < 2 (rejected).
    let res = client.try_remove_signer(&signers.get_unchecked(1));
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_remove_unknown_signer_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let res = client.try_remove_signer(&Address::generate(&env));
    assert_eq!(res, Err(Ok(ValidatorError::SignerNotFound)));
}

#[test]
fn test_verify_signatures_meets_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);
    let presented: Vec<Address> = vec![&env, signers.get_unchecked(0), signers.get_unchecked(1)];
    assert_eq!(client.count_valid_signers(&presented), 2u32);
    assert!(client.verify_signatures(&presented));
    client.enforce_signatures(&presented); // does not panic
}

#[test]
fn test_verify_signatures_below_threshold_reverts() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);
    let presented: Vec<Address> = vec![&env, signers.get_unchecked(0)];
    assert!(!client.verify_signatures(&presented));
    let res = client.try_enforce_signatures(&presented);
    assert_eq!(res, Err(Ok(ValidatorError::InsufficientWeight)));
}

#[test]
fn test_count_valid_signers_ignores_duplicates_and_unknowns() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);
    let presented: Vec<Address> = vec![
        &env,
        signers.get_unchecked(0),
        signers.get_unchecked(0), // duplicate -> counted once
        Address::generate(&env),  // unknown -> ignored
    ];
    assert_eq!(client.count_valid_signers(&presented), 1u32);
}

#[test]
fn test_set_quorum_threshold_success() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);

    // Initial config has threshold 2 with 3 signers
    let config = client.get_signer_config();
    assert_eq!(config.threshold, 2u32);

    // Update threshold to 3
    client.set_quorum_threshold(&3u32);
    let updated = client.get_signer_config();
    assert_eq!(updated.threshold, 3u32);
}

#[test]
fn test_set_quorum_threshold_blocks_below_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    // Set threshold to 3 (max with 3 signers)
    client.set_quorum_threshold(&3u32);

    // Try to present only 2 signatures -> should fail
    let presented: Vec<Address> = vec![&env, signers.get_unchecked(0), signers.get_unchecked(1)];
    assert!(!client.verify_signatures(&presented));
}

#[test]
fn test_set_quorum_threshold_rejects_zero() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let res = client.try_set_quorum_threshold(&0u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_set_quorum_threshold_rejects_exceeds_signers() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);
    let res = client.try_set_quorum_threshold(&4u32); // only 3 signers
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_quorum_threshold_update_enforces_new_requirement() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    // Initial: 2-of-3 signers, 2 signatures should pass
    let two_sigs: Vec<Address> = vec![&env, signers.get_unchecked(0), signers.get_unchecked(1)];
    assert!(client.verify_signatures(&two_sigs));

    // Raise the quorum threshold to require all 3 signers.
    client.set_quorum_threshold(&3u32);

    // Same 2 signatures should now fail under the new, stricter threshold.
    assert!(!client.verify_signatures(&two_sigs));

    // But all 3 should pass
    let three_sigs: Vec<Address> = vec![
        &env,
        signers.get_unchecked(0),
        signers.get_unchecked(1),
        signers.get_unchecked(2),
    ];
    assert!(client.verify_signatures(&three_sigs));
}

// ── Quorum Boundary, Mid-Lifecycle Signer Mutation & Expiry Tests ───────────

#[test]
fn test_exact_quorum_boundary_pass() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env); // 3-signer account: A(2), B(1), C(1), threshold 3

    // Exact quorum: A(2) + B(1) = 3 == threshold 3
    let exact_keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    assert_eq!(client.tally_weight(&account, &exact_keys), 3u32);
    assert!(client.verify_threshold(&account, &exact_keys));
    client.enforce_threshold(&account, &exact_keys); // Passes without error
}

#[test]
fn test_one_below_quorum_boundary_fail() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env); // threshold 3

    // One below quorum: B(1) + C(1) = 2 < 3
    let below_keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xB2), key(&env, 0xC3)];
    assert_eq!(client.tally_weight(&account, &below_keys), 2u32);
    assert!(!client.verify_threshold(&account, &below_keys));

    let res = client.try_enforce_threshold(&account, &below_keys);
    assert_eq!(res, Err(Ok(ValidatorError::InsufficientWeight)));
}

#[test]
fn test_duplicate_signer_scenario_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup(&env); // threshold 3

    // Presenting duplicate signer A(2) + A(2) -> Rejected as DuplicateSigner
    let dup_keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xA1)];
    let tally_res = client.try_tally_weight(&account, &dup_keys);
    assert_eq!(tally_res, Err(Ok(ValidatorError::DuplicateSigner)));

    let verify_res = client.try_verify_threshold(&account, &dup_keys);
    assert_eq!(verify_res, Err(Ok(ValidatorError::DuplicateSigner)));
}

#[test]
fn test_duplicate_admin_signer_ignored_in_count() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env); // 2-of-3 threshold

    // Presenting duplicate signer S0 twice: counted only once (count = 1 < 2)
    let dup_presented: Vec<Address> =
        vec![&env, signers.get_unchecked(0), signers.get_unchecked(0)];
    assert_eq!(client.count_valid_signers(&dup_presented), 1u32);
    assert!(!client.verify_signatures(&dup_presented));

    let res = client.try_enforce_signatures(&dup_presented);
    assert_eq!(res, Err(Ok(ValidatorError::InsufficientWeight)));
}

#[test]
fn test_signer_addition_mid_proposal_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env); // 2-of-3 signers: [S0, S1, S2], threshold 2

    // Mid-proposal: Admin adds S3
    let s3 = Address::generate(&env);
    client.add_signer(&s3);

    // Signature set [S0, S3] presented: S3 is now active and counted towards quorum
    let presented: Vec<Address> = vec![&env, signers.get_unchecked(0), s3];
    assert_eq!(client.count_valid_signers(&presented), 2u32);
    assert!(client.verify_signatures(&presented));
    client.enforce_signatures(&presented);
}

#[test]
fn test_signer_removal_mid_proposal_lifecycle() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env); // 2-of-3 signers: [S0, S1, S2], threshold 2

    // Mid-proposal: Admin removes S2
    client.remove_signer(&signers.get_unchecked(2));

    // Presenting [S0, S2] fails because S2 is no longer a valid signer
    let invalid_presented: Vec<Address> =
        vec![&env, signers.get_unchecked(0), signers.get_unchecked(2)];
    assert_eq!(client.count_valid_signers(&invalid_presented), 1u32);
    assert!(!client.verify_signatures(&invalid_presented));
    let res = client.try_enforce_signatures(&invalid_presented);
    assert_eq!(res, Err(Ok(ValidatorError::InsufficientWeight)));

    // Presenting [S0, S1] succeeds as both remain active signers
    let valid_presented: Vec<Address> =
        vec![&env, signers.get_unchecked(0), signers.get_unchecked(1)];
    assert_eq!(client.count_valid_signers(&valid_presented), 2u32);
    assert!(client.verify_signatures(&valid_presented));
}

#[test]
fn test_proposal_expiry_blocks_partially_signed_proposal_approval() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env); // threshold 3
    let pid = proposal_id(&env, 0x99);

    // Submit proposal expiring at ledger 100
    client.submit_action(&pid, &100u32);
    env.ledger().set_sequence_number(50);

    // Partially-signed: weight 1 < threshold 3 fails
    let partial_keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xC3)];
    let res_partial = client.try_approve_action(&account, &pid, &partial_keys);
    assert_eq!(res_partial, Err(Ok(ValidatorError::InsufficientWeight)));

    // Advance past expiration ledger (seq 101 > 100)
    env.ledger().set_sequence_number(101);

    // Submitting full signatures now fails with ProposalExpired
    let full_keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    let res_expired = client.try_approve_action(&account, &pid, &full_keys);
    assert_eq!(res_expired, Err(Ok(ValidatorError::ProposalExpired)));
}

#[test]
fn test_proposal_expiry_blocks_execution_of_locked_proposal() {
    let env = Env::default();
    env.mock_all_auths();
    let (account, client) = setup_with_timelock(&env); // 10s timelock delay
    let pid = proposal_id(&env, 0x88);

    // Submit proposal expiring at ledger 100
    env.ledger().set_sequence_number(10);
    client.submit_action(&pid, &100u32);

    // Approve proposal at ledger 50 -> transitions to Locked
    env.ledger().set_sequence_number(50);
    let full_keys: Vec<BytesN<32>> = vec![&env, key(&env, 0xA1), key(&env, 0xB2)];
    client.approve_action(&account, &pid, &full_keys);
    assert_eq!(client.get_proposal(&pid).state, ProposalState::Locked);

    // Advance timestamp so timelock elapses, but sequence passes expiration (ledger 105 > 100)
    env.ledger().set_timestamp(1_000_015);
    env.ledger().set_sequence_number(105);

    // Execution fails because the proposal expired
    let res = client.try_execute_action(&pid);
    assert_eq!(res, Err(Ok(ValidatorError::ProposalExpired)));
}

// ── Slashing: Missed Vote Penalty Tests ──────────────────────────────────────

#[test]
fn test_configure_slashing() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);

    client.configure_slashing(&5u32, &25u32, &3u32);

    let config = client.get_slashing_config();
    assert_eq!(config.missed_vote_threshold, 5u32);
    assert_eq!(config.penalty_weight_reduction_pct, 25u32);
    assert_eq!(config.recovery_active_votes, 3u32);
}

#[test]
fn test_configure_slashing_defaults() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(MultisigValidator, ());
    let client = MultisigValidatorClient::new(&env, &contract_id);

    let config = client.get_slashing_config();
    assert_eq!(config.missed_vote_threshold, 3u32);
    assert_eq!(config.penalty_weight_reduction_pct, 50u32);
    assert_eq!(config.recovery_active_votes, 3u32);
}

#[test]
fn test_configure_slashing_rejects_zero_threshold() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);

    let res = client.try_configure_slashing(&0u32, &50u32, &3u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_configure_slashing_rejects_over_100_pct() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, _signers, client) = setup_admin(&env);

    let res = client.try_configure_slashing(&3u32, &101u32, &3u32);
    assert_eq!(res, Err(Ok(ValidatorError::InvalidThreshold)));
}

#[test]
fn test_get_signer_vote_record_default() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    let record =
        client.get_signer_vote_record(&signers.get_unchecked(0), &signers.get_unchecked(1));
    assert_eq!(record.consecutive_missed, 0u32);
    assert_eq!(record.consecutive_active, 0u32);
    assert!(!record.penalized);
}

#[test]
fn test_effective_weight_normal() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    let weight = client.effective_weight(&signers.get_unchecked(0), &signers.get_unchecked(1));
    // Base weight is 100 (fixed lookup, 10000 bps)
    assert_eq!(weight, 100u32);
}

#[test]
fn test_effective_weight_penalized() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    // Configure slashing: 50% reduction
    client.configure_slashing(&2u32, &50u32, &3u32);

    // Mark missed votes to trigger penalty (threshold=2)
    // We need to manually set the vote record to penalized state
    // by calling mark_missed_votes with expired proposals

    // Submit a proposal
    let pid = proposal_id(&env, 0xAA);
    client.submit_action(&pid, &0u32);

    // Mark it as expired
    env.ledger().set_sequence_number(1001); // Past default expiry in test mode

    // Mark missed votes for all signers
    let expired: Vec<BytesN<32>> = vec![&env, pid];
    client.mark_missed_votes(&signers.get_unchecked(0), &expired);

    // Check vote record
    let record =
        client.get_signer_vote_record(&signers.get_unchecked(0), &signers.get_unchecked(1));
    assert_eq!(record.consecutive_missed, 1u32);
    assert!(!record.penalized); // Not yet at threshold

    // Mark another miss
    let pid2 = proposal_id(&env, 0xBB);
    client.submit_action(&pid2, &0u32);
    // pid2 is submitted at ledger 1001, so it expires at 1001 + 1000 = 2001;
    // is_expired uses a strict `>` check, so the boundary itself (2001)
    // does not yet count as expired.
    env.ledger().set_sequence_number(2002);
    let expired2: Vec<BytesN<32>> = vec![&env, pid2];
    client.mark_missed_votes(&signers.get_unchecked(0), &expired2);

    let record2 =
        client.get_signer_vote_record(&signers.get_unchecked(0), &signers.get_unchecked(1));
    assert_eq!(record2.consecutive_missed, 2u32);
    assert!(record2.penalized); // At threshold

    // Effective weight should be reduced (100 * 50% = 50)
    let weight = client.effective_weight(&signers.get_unchecked(0), &signers.get_unchecked(1));
    assert_eq!(weight, 50u32);
}

#[test]
fn test_penalty_recovery_after_active_votes() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, signers, client) = setup_admin(&env);

    // Configure slashing: threshold=2, 50% reduction, recovery=3
    client.configure_slashing(&2u32, &50u32, &3u32);

    // Manually set a signer as penalized with consecutive_missed=3
    let now = env.ledger().sequence();
    let record = SignerVoteRecord {
        consecutive_missed: 3,
        consecutive_active: 0,
        penalized: true,
        last_vote_ledger: now,
    };
    env.as_contract(&client.address, || {
        env.storage().persistent().set(
            &DataKey::SignerVoteRecord(
                signers.get_unchecked(0).clone(),
                signers.get_unchecked(1).clone(),
            ),
            &record,
        );
    });

    // Verify penalized
    let weight_before =
        client.effective_weight(&signers.get_unchecked(0), &signers.get_unchecked(1));
    assert_eq!(weight_before, 50u32); // 50% penalty on base 100

    // Simulate 3 active votes to trigger recovery
    for _ in 0..3 {
        env.as_contract(&client.address, || {
            let current: SignerVoteRecord = env
                .storage()
                .persistent()
                .get(&DataKey::SignerVoteRecord(
                    signers.get_unchecked(0).clone(),
                    signers.get_unchecked(1).clone(),
                ))
                .unwrap();

            let updated = SignerVoteRecord {
                consecutive_missed: 0,
                consecutive_active: current.consecutive_active + 1,
                penalized: current.consecutive_active + 1 < 3,
                last_vote_ledger: current.last_vote_ledger,
            };
            env.storage().persistent().set(
                &DataKey::SignerVoteRecord(
                    signers.get_unchecked(0).clone(),
                    signers.get_unchecked(1).clone(),
                ),
                &updated,
            );
        });
    }

    // Verify recovery
    let weight_after =
        client.effective_weight(&signers.get_unchecked(0), &signers.get_unchecked(1));
    assert_eq!(weight_after, 100u32); // Back to full weight
}

fn extend_multisig_ttls(env: &Env) {
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 40_000_001;
        li.min_persistent_entry_ttl = 40_000_000;
    });
}

#[test]
fn test_decay_inside_grace_no_decay() {
    let env = Env::default();
    env.mock_all_auths();
    extend_multisig_ttls(&env);
    let (_admin, signers, client) = setup_admin(&env);
    let account = signers.get_unchecked(0).clone();
    let signer = signers.get_unchecked(1).clone();

    env.ledger().set_sequence_number(1);
    client.cast_vote(&account, &signer);
    // Default grace is 1000 ledgers
    assert_eq!(client.effective_weight(&account, &signer), 100u32);
    env.ledger().set_sequence_number(500);
    assert_eq!(client.effective_weight(&account, &signer), 100u32);
    env.ledger().set_sequence_number(1000);
    assert_eq!(client.effective_weight(&account, &signer), 100u32);
}

#[test]
fn test_decay_linear_progression() {
    let env = Env::default();
    env.mock_all_auths();
    extend_multisig_ttls(&env);
    let (_admin, signers, client) = setup_admin(&env);
    let account = signers.get_unchecked(0).clone();
    let signer = signers.get_unchecked(1).clone();

    env.ledger().set_sequence_number(1);
    // Record initial vote to anchor last_vote_ledger
    client.cast_vote(&account, &signer);
    let anchor = env.ledger().sequence();

    // One period past grace: 10% loss -> 90
    env.ledger().set_sequence_number(anchor + 1000 + 1000);
    assert_eq!(client.effective_weight(&account, &signer), 90u32);

    // Two periods: 20% -> 80
    env.ledger().set_sequence_number(anchor + 1000 + 2000);
    assert_eq!(client.effective_weight(&account, &signer), 80u32);

    // Nine periods: 90% -> floor 10
    env.ledger().set_sequence_number(anchor + 1000 + 9000);
    assert_eq!(client.effective_weight(&account, &signer), 10u32);

    // Further -> stays at floor
    env.ledger().set_sequence_number(anchor + 1000 + 20000);
    assert_eq!(client.effective_weight(&account, &signer), 10u32);
}

#[test]
fn test_decay_restoration_on_vote() {
    let env = Env::default();
    env.mock_all_auths();
    extend_multisig_ttls(&env);
    let (_admin, signers, client) = setup_admin(&env);
    let account = signers.get_unchecked(0).clone();
    let signer = signers.get_unchecked(1).clone();

    env.ledger().set_sequence_number(1);
    client.cast_vote(&account, &signer);
    let anchor = env.ledger().sequence();
    env.ledger().set_sequence_number(anchor + 1000 + 3000);
    assert_eq!(client.effective_weight(&account, &signer), 70u32);

    // Casting a vote restores full weight and resets clock
    client.cast_vote(&account, &signer);
    assert_eq!(client.effective_weight(&account, &signer), 100u32);

    // Grace restarts from new anchor
    let new_anchor = env.ledger().sequence();
    env.ledger().set_sequence_number(new_anchor + 500);
    assert_eq!(client.effective_weight(&account, &signer), 100u32);
    env.ledger().set_sequence_number(new_anchor + 1000 + 1000);
    assert_eq!(client.effective_weight(&account, &signer), 90u32);
}

#[test]
fn test_decay_interaction_with_slashing() {
    let env = Env::default();
    env.mock_all_auths();
    extend_multisig_ttls(&env);
    let (_admin, signers, client) = setup_admin(&env);
    let account = signers.get_unchecked(0).clone();
    let signer = signers.get_unchecked(1).clone();

    client.configure_slashing(&2u32, &50u32, &3u32);
    // Trigger penalty
    let pid = proposal_id(&env, 0xCC);
    client.submit_action(&pid, &0u32);
    env.ledger().set_sequence_number(1001);
    let expired: Vec<BytesN<32>> = vec![&env, pid];
    client.mark_missed_votes(&account, &expired);
    let pid2 = proposal_id(&env, 0xDD);
    client.submit_action(&pid2, &0u32);
    env.ledger().set_sequence_number(2002);
    let expired2: Vec<BytesN<32>> = vec![&env, pid2];
    client.mark_missed_votes(&account, &expired2);

    // Penalized weight is 50, decay anchor is still initial (now 0 -> now)
    // Need to anchor decay by casting a vote first, then penalize, then decay
    // Reset and do decay+penalty interaction
    env.ledger().set_sequence_number(3000);
    client.cast_vote(&account, &signer); // resets penalty? Actually need 3 active to recover, so still penalized
    // Manually set penalized again for interaction test
    env.as_contract(&client.address, || {
        env.storage().persistent().set(
            &DataKey::SignerVoteRecord(account.clone(), signer.clone()),
            &SignerVoteRecord { consecutive_missed: 2, consecutive_active: 0, penalized: true, last_vote_ledger: 3000 },
        );
    });
    assert_eq!(client.effective_weight(&account, &signer), 50u32);

    // Decay on top of penalty: 1 period past grace -> 10% of 50 = 5 -> 45, floor 10% of base (10) still above
    env.ledger().set_sequence_number(3000 + 1000 + 1000);
    // decay_bps = 1000, base after slash is 50, decay reduces 50*1000/10000=5 -> 45
    assert_eq!(client.effective_weight(&account, &signer), 45u32);

    // Voting restores both
    client.cast_vote(&account, &signer);
    // Need 3 votes to clear penalized, but decay clock resets immediately
    // After one vote, still penalized but decay reset to 0
    // Weight = 50 (still penalized, no decay)
    assert_eq!(client.effective_weight(&account, &signer), 50u32);
    client.cast_vote(&account, &signer);
    client.cast_vote(&account, &signer);
    // After 3, penalized cleared -> 100
    assert_eq!(client.effective_weight(&account, &signer), 100u32);
}
