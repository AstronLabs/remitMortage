use super::*;
use soroban_sdk::{testutils::Address as _, vec, Env};

#[test]
fn lock_mint_and_burn_use_the_bridge_interface() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let recipient = Address::generate(&env);
    let contract_id = env.register(StellarBridgeAdapter, ());
    let client = StellarBridgeAdapterClient::new(&env, &contract_id);

    client.initialize(&admin, &10, &1_000, &vec![&env, Symbol::short(b"ethereum")]);
    let operation_id = client.lock(&user, &100, &Symbol::short(b"ethereum"), &recipient);
    client.mint(&operation_id, &recipient, &100, &Symbol::short(b"stellar"));
    let burn_id = client.burn(&user, &100, &Symbol::short(b"ethereum"), &recipient);

    assert_ne!(operation_id, burn_id);
    assert_eq!(client.get_state().total_locked, 100);
    assert_eq!(client.get_state().total_minted, 100);
    assert_eq!(client.get_state().total_burned, 100);
}

#[test]
fn paused_bridge_rejects_operations_and_signature_requires_operation() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(StellarBridgeAdapter, ());
    let client = StellarBridgeAdapterClient::new(&env, &contract_id);

    client.initialize(&admin, &10, &1_000, &vec![&env, Symbol::short(b"ethereum")]);
    assert!(!client.verify_signature(&Symbol::short(b"missing"), &Symbol::short(b"sig")));
    client.pause(&admin);
    assert_eq!(
        client.try_lock(&user, &100, &Symbol::short(b"ethereum"), &user),
        Err(Ok(BridgeError::BridgePaused))
    );
}