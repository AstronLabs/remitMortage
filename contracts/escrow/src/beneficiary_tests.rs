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
