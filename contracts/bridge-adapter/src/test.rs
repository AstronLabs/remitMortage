// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

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

    client.initialize(&admin, &10, &1_000, &vec![&env, symbol_short!("ethereum")]);
    let operation_id = client.lock(&user, &100, &symbol_short!("ethereum"), &recipient);
    client.mint(&operation_id, &recipient, &100, &symbol_short!("stellar"));
    let burn_id = client.burn(&user, &100, &symbol_short!("ethereum"), &recipient);

    assert_ne!(operation_id, burn_id);
    assert_eq!(client.get_state().total_locked, 100);
    assert_eq!(client.get_state().total_minted, 100);
    assert_eq!(client.get_state().total_burned, 100);
}

/// Runs the generic, trait-level compliance suite against the shipped stub,
/// proving the suite is reusable by any `BridgeAdapter` implementation.
#[test]
fn stub_adapter_passes_the_shared_compliance_suite() {
    let env = Env::default();
    let admin = Address::generate(&env);
    crate::compliance::assert_adapter_compliance::<StellarBridgeAdapter, _>(&env, move |env| {
        let contract_id = env.register(StellarBridgeAdapter, ());
        let client = StellarBridgeAdapterClient::new(env, &contract_id);
        client.initialize(
            &admin,
            &10,
            &crate::compliance::COMPLIANCE_AMOUNT,
            &vec![env, symbol_short!("ethereum")],
        );
        contract_id
    });
}

#[test]
fn paused_bridge_rejects_operations_and_signature_requires_operation() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let contract_id = env.register(StellarBridgeAdapter, ());
    let client = StellarBridgeAdapterClient::new(&env, &contract_id);

    client.initialize(&admin, &10, &1_000, &vec![&env, symbol_short!("ethereum")]);
    assert!(!client.verify_signature(&symbol_short!("missing"), &symbol_short!("sig")));
    client.pause(&admin);
    assert_eq!(
        client.try_lock(&user, &100, &symbol_short!("ethereum"), &user),
        Err(Ok(BridgeError::BridgePaused))
    );
}
