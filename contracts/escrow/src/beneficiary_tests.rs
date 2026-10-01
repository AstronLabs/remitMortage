// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use super::*;
use soroban_sdk::{
    testutils::Address as _, testutils::Ledger, token::StellarAssetClient, Address, Env, Symbol,
    Vec,
};

fn setup(env: &Env) -> (Address, Address, Address, EscrowContractClient<'_>, Symbol) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let beneficiary = Address::generate(env);
    let attestor = Address::generate(env);
    let token_admin = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(token_admin)
        .address();
    StellarAssetClient::new(env, &token).mint(&owner, &1_000i128);
    let contract = env.register(EscrowContract, ());
    let client = EscrowContractClient::new(env, &contract);
    client.initialize(&EscrowConfig {
        admin: admin.clone(),
        token,
        lending_pool: Address::generate(env),
        savings_target: 1_000,
        max_duration_ledgers: 1_000,
        early_withdrawal_penalty_bps: 0,
        min_duration_ledgers: 0,
        penalty_bps_tier1: 0,
        penalty_bps_tier2: 0,
        penalty_bps_tier3: 0,
        penalty_bps_tier4: 0,
        grace_period_ledgers: 1,
        default_penalty_bps: 0,
        instance_bump_amount: 1_000,
        instance_lifetime_threshold: 100,
        persistent_bump_amount: 1_000,
        persistent_lifetime_threshold: 100,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
    });
    client.set_beneficiary_inactivity(&10);
    client.configure_beneficiary_attestors(&Vec::from_array(env, [attestor.clone()]), &1);
    let goal = Symbol::new(env, "home");
    client.deposit(&owner, &goal, &500);
    (owner, beneficiary, attestor, client, goal)
}

#[test]
fn owner_can_designate_and_remove_beneficiary() {
    let env = Env::default();
    let (owner, beneficiary, _attestor, client, goal) = setup(&env);
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));
    assert_eq!(client.get_beneficiary(&owner, &goal), Some(beneficiary));
    client.remove_beneficiary(&owner, &goal);
    assert_eq!(client.get_beneficiary(&owner, &goal), None);
}

#[test]
fn owner_activity_blocks_stale_inactivity_claim() {
    let env = Env::default();
    let (owner, beneficiary, attestor, client, goal) = setup(&env);
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 9);
    client.deposit(&owner, &goal, &100);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 9);
    let attestations = Vec::from_array(&env, [attestor]);
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &beneficiary, &attestations)
        .is_err());
    assert_eq!(client.get_balance(&owner, &goal), 600);
}

#[test]
fn beneficiary_claim_transfers_once_after_inactivity_and_quorum() {
    let env = Env::default();
    let (owner, beneficiary, attestor, client, goal) = setup(&env);
    let token_address = client.get_escrow_config().token;
    let token = soroban_sdk::token::Client::new(&env, &token_address);
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);
    assert_eq!(
        client.claim_as_beneficiary(&owner, &goal, &beneficiary, &attestations),
        500
    );
    assert_eq!(token.balance(&beneficiary), 500);
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &beneficiary, &attestations)
        .is_err());
}

#[test]
fn claim_requires_both_inactivity_and_quorum() {
    let env = Env::default();
    let (owner, beneficiary, attestor, client, goal) = setup(&env);
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));

    let second_attestor = Address::generate(&env);
    client.configure_beneficiary_attestors(
        &Vec::from_array(&env, [attestor.clone(), second_attestor.clone()]),
        &2,
    );

    // A valid single attestation is insufficient before the inactivity window.
    let one = Vec::from_array(&env, [attestor.clone()]);
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &beneficiary, &one)
        .is_err());

    // At the exact inactivity boundary, the full quorum succeeds.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let full = Vec::from_array(&env, [attestor, second_attestor]);
    assert_eq!(client.claim_as_beneficiary(&owner, &goal, &beneficiary, &full), 500);
}

#[test]
fn invalid_attestor_sets_are_rejected() {
    let env = Env::default();
    let (owner, beneficiary, attestor, client, goal) = setup(&env);
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);

    let unknown = Address::generate(&env);
    let unknown_set = Vec::from_array(&env, [unknown]);
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &beneficiary, &unknown_set)
        .is_err());

    let duplicate = Vec::from_array(&env, [attestor.clone(), attestor]);
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &beneficiary, &duplicate)
        .is_err());
}

#[test]
fn replaced_beneficiary_cannot_claim() {
    let env = Env::default();
    let (owner, old_beneficiary, attestor, client, goal) = setup(&env);
    let new_beneficiary = Address::generate(&env);
    client.set_beneficiary(&owner, &goal, &Some(old_beneficiary.clone()));
    client.set_beneficiary(&owner, &goal, &Some(new_beneficiary.clone()));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);

    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &old_beneficiary, &attestations)
        .is_err());
    assert_eq!(client.claim_as_beneficiary(&owner, &goal, &new_beneficiary, &attestations), 500);
}

#[test]
fn owner_activity_resets_exact_deadline() {
    let env = Env::default();
    let (owner, beneficiary, attestor, client, goal) = setup(&env);
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 9);

    // A deposit at the old deadline records new owner activity.
    client.deposit(&owner, &goal, &100);
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 9);
    let attestations = Vec::from_array(&env, [attestor]);
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &beneficiary, &attestations)
        .is_err());

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 1);
    assert_eq!(client.claim_as_beneficiary(&owner, &goal, &beneficiary, &attestations), 600);
}

// ── Multi-beneficiary split tests ────────────────────────────────────────────

/// Helper that builds a BeneficiaryList from a slice of (address, share_bps)
/// pairs, borrowing the env for the inner Vec allocation.
fn make_list(
    env: &Env,
    entries: &[(Address, u32)],
) -> BeneficiaryList {
    let mut splits = Vec::new(env);
    for (addr, bps) in entries {
        splits.push_back(BeneficiarySplit {
            beneficiary: addr.clone(),
            share_bps: *bps,
        });
    }
    BeneficiaryList { splits }
}

// ── Share-sum validation ──────────────────────────────────────────────────────

#[test]
fn set_beneficiary_list_rejects_shares_not_summing_to_10000() {
    let env = Env::default();
    let (owner, _b, _a, client, goal) = setup(&env);

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    // 4000 + 4000 = 8000, not 10 000 → must be rejected.
    let bad_list = make_list(&env, &[(b1.clone(), 4_000), (b2.clone(), 4_000)]);
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &bad_list)
        .is_err());

    // 5001 + 5000 = 10 001 → also rejected.
    let over_list = make_list(&env, &[(b1.clone(), 5_001), (b2.clone(), 5_000)]);
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &over_list)
        .is_err());

    // Single recipient at exactly 10 000 → accepted.
    let exact_list = make_list(&env, &[(b1.clone(), 10_000)]);
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &exact_list)
        .is_ok());
}

#[test]
fn set_beneficiary_list_rejects_zero_share_entry() {
    let env = Env::default();
    let (owner, _b, _a, client, goal) = setup(&env);

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    // One entry has share_bps = 0.
    let bad = make_list(&env, &[(b1.clone(), 0), (b2.clone(), 10_000)]);
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &bad)
        .is_err());
}

#[test]
fn set_beneficiary_list_rejects_duplicate_address() {
    let env = Env::default();
    let (owner, _b, _a, client, goal) = setup(&env);

    let b1 = Address::generate(&env);
    // Same address in two entries — must be rejected even when shares sum correctly.
    let dup = make_list(&env, &[(b1.clone(), 5_000), (b1.clone(), 5_000)]);
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &dup)
        .is_err());
}

#[test]
fn set_beneficiary_list_rejects_empty_list() {
    let env = Env::default();
    let (owner, _b, _a, client, goal) = setup(&env);

    let empty = BeneficiaryList { splits: Vec::new(&env) };
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &empty)
        .is_err());
}

#[test]
fn set_beneficiary_list_rejects_self_as_recipient() {
    let env = Env::default();
    let (owner, _b, _a, client, goal) = setup(&env);

    // Owner names themselves — must be rejected.
    let self_list = make_list(&env, &[(owner.clone(), 10_000)]);
    assert!(client
        .try_set_beneficiary_list(&owner, &goal, &self_list)
        .is_err());
}

// ── Happy-path multi-split claim ─────────────────────────────────────────────

#[test]
fn two_beneficiary_split_distributes_exact_proportions() {
    let env = Env::default();
    let (owner, _b, attestor, client, goal) = setup(&env);
    let token_address = client.get_escrow_config().token;
    let token = soroban_sdk::token::Client::new(&env, &token_address);

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);

    // 60 / 40 split over 500 tokens deposited in setup().
    let list = make_list(&env, &[(b1.clone(), 6_000), (b2.clone(), 4_000)]);
    client.set_beneficiary_list(&owner, &goal, &list);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);

    // Either beneficiary can trigger the claim.
    let total = client.claim_as_beneficiary(&owner, &goal, &b1, &attestations);
    assert_eq!(total, 500);

    // b1 receives 60 % → 300, b2 receives 40 % → 200.
    assert_eq!(token.balance(&b1), 300);
    assert_eq!(token.balance(&b2), 200);
}

#[test]
fn three_beneficiary_split_remainder_goes_to_last_recipient() {
    let env = Env::default();
    let (owner, _b, attestor, client, goal) = setup(&env);
    let token_address = client.get_escrow_config().token;
    let token = soroban_sdk::token::Client::new(&env, &token_address);

    // Deposit an extra 1 token so balance = 501 (prime-ish, exercises rounding).
    client.deposit(&owner, &goal, &1);

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let b3 = Address::generate(&env);

    // 33.33…% each (rounds down); last recipient absorbs the 1-stroop remainder.
    let list = make_list(
        &env,
        &[
            (b1.clone(), 3_334),
            (b2.clone(), 3_333),
            (b3.clone(), 3_333),
        ],
    );
    client.set_beneficiary_list(&owner, &goal, &list);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);

    // b2 is the caller this time — any listed address may trigger.
    let total = client.claim_as_beneficiary(&owner, &goal, &b2, &attestations);
    assert_eq!(total, 501);

    let share_b1 = token.balance(&b1); // floor(501 * 3334 / 10000) = 167
    let share_b2 = token.balance(&b2); // floor(501 * 3333 / 10000) = 166
    let share_b3 = token.balance(&b3); // 501 - 167 - 166 = 168 (remainder)
    assert_eq!(share_b1 + share_b2 + share_b3, 501);
    // Every recipient must have received a positive non-zero amount.
    assert!(share_b1 > 0);
    assert!(share_b2 > 0);
    assert!(share_b3 > 0);
}

#[test]
fn multi_split_claim_is_idempotent_guard_prevents_double_claim() {
    let env = Env::default();
    let (owner, _b, attestor, client, goal) = setup(&env);

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let list = make_list(&env, &[(b1.clone(), 5_000), (b2.clone(), 5_000)]);
    client.set_beneficiary_list(&owner, &goal, &list);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor.clone()]);

    // First claim succeeds.
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &b1, &attestations)
        .is_ok());

    // Second attempt — even from a different listed address — must fail.
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &b2, &attestations)
        .is_err());
}

#[test]
fn unlisted_address_cannot_trigger_multi_split_claim() {
    let env = Env::default();
    let (owner, _b, attestor, client, goal) = setup(&env);

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let intruder = Address::generate(&env);

    let list = make_list(&env, &[(b1.clone(), 7_000), (b2.clone(), 3_000)]);
    client.set_beneficiary_list(&owner, &goal, &list);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);

    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &intruder, &attestations)
        .is_err());
}

// ── set_beneficiary_list clears legacy single address ────────────────────────

#[test]
fn setting_list_removes_legacy_single_beneficiary() {
    let env = Env::default();
    let (owner, legacy_ben, attestor, client, goal) = setup(&env);
    let token_address = client.get_escrow_config().token;
    let token = soroban_sdk::token::Client::new(&env, &token_address);

    // First, set a legacy single beneficiary.
    client.set_beneficiary(&owner, &goal, &Some(legacy_ben.clone()));

    let b1 = Address::generate(&env);
    let b2 = Address::generate(&env);
    let list = make_list(&env, &[(b1.clone(), 5_000), (b2.clone(), 5_000)]);

    // Setting the list must clear the old single-address designation.
    client.set_beneficiary_list(&owner, &goal, &list);
    assert_eq!(client.get_beneficiary(&owner, &goal), None);

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);

    // The old beneficiary can no longer claim.
    assert!(client
        .try_claim_as_beneficiary(&owner, &goal, &legacy_ben, &attestations)
        .is_err());

    // A listed address succeeds and both recipients get their share.
    let total = client.claim_as_beneficiary(&owner, &goal, &b1, &attestations);
    assert_eq!(total, 500);
    assert_eq!(token.balance(&b1), 250);
    assert_eq!(token.balance(&b2), 250);
}

// ── Legacy single-beneficiary backward compatibility ─────────────────────────

#[test]
fn legacy_single_beneficiary_still_works_without_list() {
    let env = Env::default();
    let (owner, beneficiary, attestor, client, goal) = setup(&env);
    let token_address = client.get_escrow_config().token;
    let token = soroban_sdk::token::Client::new(&env, &token_address);

    // No list is ever set — use the original single-address path.
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));

    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 10);
    let attestations = Vec::from_array(&env, [attestor]);

    let claimed = client.claim_as_beneficiary(&owner, &goal, &beneficiary, &attestations);
    assert_eq!(claimed, 500);
    assert_eq!(token.balance(&beneficiary), 500);
}

#[test]
fn remove_beneficiary_list_allows_re_designation() {
    let env = Env::default();
    let (owner, beneficiary, _attestor, client, goal) = setup(&env);

    let b1 = Address::generate(&env);
    let list = make_list(&env, &[(b1.clone(), 10_000)]);
    client.set_beneficiary_list(&owner, &goal, &list);

    // Owner removes the list.
    client.remove_beneficiary_list(&owner, &goal);
    assert!(client.get_beneficiary_list(&owner, &goal).is_none());

    // After removal, owner can set a new legacy single beneficiary.
    client.set_beneficiary(&owner, &goal, &Some(beneficiary.clone()));
    assert_eq!(client.get_beneficiary(&owner, &goal), Some(beneficiary));
}
