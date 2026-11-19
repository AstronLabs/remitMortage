// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    vec, Env,
};

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

// ── Per-source-chain daily volume cap (issue #858) ──────────────────────
//
// `mint`'s `source_chain` is checked against the operation's stored
// `source_chain`, which `lock`/`burn` always set to `symbol_short!("stellar")`
// (this stub has no real external relay — see the module doc comment). So
// every test below keys the cap by `"stellar"`, matching the only
// `source_chain` a `mint` can ever actually be completed against here.

const STELLAR: Symbol = symbol_short!("stellar");
const ETHEREUM: Symbol = symbol_short!("ethereum");

fn setup_bridge(env: &Env) -> (Address, StellarBridgeAdapterClient<'_>, Address, Address) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let user = Address::generate(env);
    let recipient = Address::generate(env);
    let contract_id = env.register(StellarBridgeAdapter, ());
    let client = StellarBridgeAdapterClient::new(env, &contract_id);
    client.initialize(&admin, &1, &10_000_000, &vec![env, ETHEREUM]);
    (admin, client, user, recipient)
}

/// Locks then mints `amount`, returning the mint's `try_mint` result so
/// callers can assert on cap rejections without panicking the test. Ok(())
/// on success; Err(Ok(BridgeError::_)) when the contract itself rejected
/// the mint — the same shape the existing `try_lock` test above compares
/// against.
fn lock_and_try_mint(
    client: &StellarBridgeAdapterClient,
    user: &Address,
    recipient: &Address,
    amount: i128,
) -> Result<(), Result<BridgeError, soroban_sdk::InvokeError>> {
    let operation_id = client.lock(user, &amount, &ETHEREUM, recipient);
    client
        .try_mint(&operation_id, recipient, &amount, &STELLAR)
        .map(|_| ())
}

#[test]
fn mint_within_the_cap_succeeds_and_tracks_cumulative_volume() {
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    assert!(lock_and_try_mint(&client, &user, &recipient, 600).is_ok());
    assert_eq!(client.get_volume_window(&STELLAR).volume, 600);

    assert!(lock_and_try_mint(&client, &user, &recipient, 250).is_ok());
    assert_eq!(client.get_volume_window(&STELLAR).volume, 850);
}

#[test]
fn mint_exceeding_the_cap_is_rejected_and_the_operation_stays_retryable() {
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    assert!(lock_and_try_mint(&client, &user, &recipient, 850).is_ok());

    // 850 + 200 = 1050 > 1000: rejected, no volume recorded for it.
    let operation_id = client.lock(&user, &200, &ETHEREUM, &recipient);
    let result = client.try_mint(&operation_id, &recipient, &200, &STELLAR);
    assert_eq!(result, Err(Ok(BridgeError::DailyVolumeCapExceeded)));
    assert_eq!(client.get_volume_window(&STELLAR).volume, 850);

    // The rejected operation was never marked completed — it can still be
    // retried (e.g. once the window rolls over) rather than being stranded.
    assert!(client.verify_signature(&operation_id, &symbol_short!("sig")));
    let retry = client.try_mint(&operation_id, &recipient, &200, &STELLAR);
    assert_eq!(retry, Err(Ok(BridgeError::DailyVolumeCapExceeded)));
}

#[test]
fn exact_boundary_transfer_that_lands_precisely_on_the_cap_succeeds() {
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    assert!(lock_and_try_mint(&client, &user, &recipient, 850).is_ok());
    // 850 + 150 = 1000 exactly: the boundary is inclusive, not exclusive.
    assert!(lock_and_try_mint(&client, &user, &recipient, 150).is_ok());
    assert_eq!(client.get_volume_window(&STELLAR).volume, 1_000);

    // One stroop over, from an empty window, is rejected.
    let operation_id = client.lock(&user, &1, &ETHEREUM, &recipient);
    assert_eq!(
        client.try_mint(&operation_id, &recipient, &1, &STELLAR),
        Err(Ok(BridgeError::DailyVolumeCapExceeded))
    );
}

#[test]
fn window_resets_after_the_rolling_window_elapses() {
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    assert!(lock_and_try_mint(&client, &user, &recipient, 1_000).is_ok());
    let operation_id = client.lock(&user, &1, &ETHEREUM, &recipient);
    assert_eq!(
        client.try_mint(&operation_id, &recipient, &1, &STELLAR),
        Err(Ok(BridgeError::DailyVolumeCapExceeded))
    );

    // Not yet a full window later: still capped.
    env.ledger().with_mut(|l| l.timestamp += 86_400 - 1);
    let still_blocked = client.lock(&user, &1, &ETHEREUM, &recipient);
    assert_eq!(
        client.try_mint(&still_blocked, &recipient, &1, &STELLAR),
        Err(Ok(BridgeError::DailyVolumeCapExceeded))
    );

    // One second further — a full window has now elapsed — the window
    // resets and the full cap is available again.
    env.ledger().with_mut(|l| l.timestamp += 1);
    assert!(lock_and_try_mint(&client, &user, &recipient, 1_000).is_ok());
    assert_eq!(client.get_volume_window(&STELLAR).volume, 1_000);
}

#[test]
fn an_uncapped_chain_never_rejects_regardless_of_amount() {
    let env = Env::default();
    let (_admin, client, user, recipient) = setup_bridge(&env);
    // No set_daily_cap call — the chain stays uncapped (default 0), exactly
    // as every existing deployment is today.

    assert_eq!(client.get_daily_cap(&STELLAR), 0);
    assert!(lock_and_try_mint(&client, &user, &recipient, 5_000_000).is_ok());
}

#[test]
fn warning_events_fire_at_eighty_percent_and_at_the_cap_but_not_before() {
    use soroban_sdk::IntoVal;

    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    let warn_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        symbol_short!("cap_warn").into_val(&env),
        STELLAR.into_val(&env),
    ];
    let full_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
        &env,
        symbol_short!("cap_full").into_val(&env),
        STELLAR.into_val(&env),
    ];

    // Below 80%: no cap_warn.
    assert!(lock_and_try_mint(&client, &user, &recipient, 500).is_ok());
    assert_eq!(
        env.events()
            .all()
            .iter()
            .filter(|e| e.1 == warn_topic)
            .count(),
        0
    );

    // Crosses 80% (500 -> 850): cap_warn fires exactly once.
    assert!(lock_and_try_mint(&client, &user, &recipient, 350).is_ok());
    assert_eq!(
        env.events()
            .all()
            .iter()
            .filter(|e| e.1 == warn_topic)
            .count(),
        1
    );

    // Reaches exactly 100% (850 -> 1000): cap_full fires exactly once.
    assert!(lock_and_try_mint(&client, &user, &recipient, 150).is_ok());
    assert_eq!(
        env.events()
            .all()
            .iter()
            .filter(|e| e.1 == full_topic)
            .count(),
        1
    );
}

#[test]
fn lowering_or_first_setting_a_cap_is_immediate_but_raising_one_requires_the_timelock() {
    let env = Env::default();
    let (admin, client, _user, _recipient) = setup_bridge(&env);

    // First-time set: immediate.
    client.set_daily_cap(&admin, &STELLAR, &1_000);
    assert_eq!(client.get_daily_cap(&STELLAR), 1_000);

    // Lowering: immediate.
    client.set_daily_cap(&admin, &STELLAR, &500);
    assert_eq!(client.get_daily_cap(&STELLAR), 500);

    // Raising via set_daily_cap directly is rejected.
    assert_eq!(
        client.try_set_daily_cap(&admin, &STELLAR, &800),
        Err(Ok(BridgeError::CapIncreaseRequiresTimelock))
    );
    assert_eq!(client.get_daily_cap(&STELLAR), 500);
}

#[test]
fn a_proposed_cap_increase_cannot_execute_before_its_timelock_elapses() {
    let env = Env::default();
    let (admin, client, _user, _recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &500);
    client.set_cap_change_delay(&admin, &100);

    let execute_after = client.propose_daily_cap_increase(&admin, &STELLAR, &2_000);

    assert_eq!(
        client.try_execute_daily_cap_increase(&admin, &STELLAR),
        Err(Ok(BridgeError::CapChangeTimelockActive))
    );
    assert_eq!(client.get_daily_cap(&STELLAR), 500);

    env.ledger().with_mut(|l| l.sequence_number = execute_after);
    client.execute_daily_cap_increase(&admin, &STELLAR);
    assert_eq!(client.get_daily_cap(&STELLAR), 2_000);

    // The pending record is cleared — nothing left to execute twice.
    assert_eq!(
        client.try_execute_daily_cap_increase(&admin, &STELLAR),
        Err(Ok(BridgeError::NoPendingCapIncrease))
    );
}

#[test]
fn cap_changes_require_admin() {
    // require_admin panics on identity mismatch (this contract's existing
    // convention — see pause/unpause/add_supported_chain), so a non-admin
    // caller surfaces as a trapped error from try_*, not a typed BridgeError.
    let env = Env::default();
    let (_admin, client, user, _recipient) = setup_bridge(&env);

    assert!(client.try_set_daily_cap(&user, &STELLAR, &1_000).is_err());
    assert!(client
        .try_propose_daily_cap_increase(&user, &STELLAR, &1_000)
        .is_err());
    assert!(client.try_set_cap_change_delay(&user, &100u32).is_err());
}

// ── Cross-chain message replay protection ───────────────────────────────
//
// Invariant (documented on `StellarBridgeAdapter::mint`): a bridge operation
// can be minted at most once. The `"completed"` status check runs before any
// state-mutating effect, so a replay can never double-apply an effect.

/// Locks `amount` and mints it, returning the operation id.
fn lock_and_mint(
    client: &StellarBridgeAdapterClient,
    user: &Address,
    recipient: &Address,
    amount: i128,
) -> Symbol {
    let operation_id = client.lock(user, &amount, &ETHEREUM, recipient);
    client.mint(&operation_id, recipient, &amount, &STELLAR);
    operation_id
}

#[test]
fn replay_of_a_processed_message_is_rejected_and_has_no_effect() {
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    let operation_id = lock_and_mint(&client, &user, &recipient, 400);
    assert_eq!(client.get_state().total_minted, 400);
    assert_eq!(client.get_volume_window(&STELLAR).volume, 400);

    // Resubmit the identical message several times.
    for _ in 0..3 {
        assert_eq!(
            client.try_mint(&operation_id, &recipient, &400, &STELLAR),
            Err(Ok(BridgeError::AlreadyProcessed))
        );
    }

    // Nothing was re-applied: counters and the volume window are unchanged.
    assert_eq!(client.get_state().total_minted, 400);
    assert_eq!(client.get_volume_window(&STELLAR).volume, 400);
}

#[test]
fn replay_is_rejected_even_when_the_daily_cap_has_room() {
    // The guard must not depend on the volume cap: with ample headroom the
    // replay would otherwise sail through the cap check.
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000_000);

    let operation_id = lock_and_mint(&client, &user, &recipient, 100);
    assert_eq!(
        client.try_mint(&operation_id, &recipient, &100, &STELLAR),
        Err(Ok(BridgeError::AlreadyProcessed))
    );
    assert_eq!(client.get_state().total_minted, 100);
}

#[test]
fn replay_with_manipulated_fields_is_still_rejected_as_already_processed() {
    let env = Env::default();
    let (_admin, client, user, recipient) = setup_bridge(&env);
    let attacker = Address::generate(&env);

    let operation_id = lock_and_mint(&client, &user, &recipient, 100);

    // Same operation id, altered amount / recipient / source chain: the
    // processed-status guard fires first, so none of these can reach a
    // later check or any effect.
    let altered = [
        client.try_mint(&operation_id, &recipient, &9_999, &STELLAR),
        client.try_mint(&operation_id, &attacker, &100, &STELLAR),
        client.try_mint(&operation_id, &recipient, &100, &ETHEREUM),
        client.try_mint(&operation_id, &attacker, &1, &ETHEREUM),
    ];
    for result in altered {
        assert_eq!(result, Err(Ok(BridgeError::AlreadyProcessed)));
    }
    assert_eq!(client.get_state().total_minted, 100);
}

#[test]
fn colliding_or_forged_operation_ids_cannot_mint_a_processed_operation_again() {
    let env = Env::default();
    let (_admin, client, user, recipient) = setup_bridge(&env);

    let first = lock_and_mint(&client, &user, &recipient, 100);
    assert_eq!(first, Symbol::new(&env, "1"));

    // Look-alike identifiers (padded, prefixed, different case) are distinct
    // keys: they resolve to no operation and mint nothing.
    for forged in ["01", "op1", "11", "0", "I", "1_"] {
        assert_eq!(
            client.try_mint(&Symbol::new(&env, forged), &recipient, &100, &STELLAR),
            Err(Ok(BridgeError::OperationNotFound)),
            "forged id {forged:?} must not match a real operation"
        );
    }
    assert_eq!(client.get_state().total_minted, 100);
}

#[test]
fn out_of_order_delivery_applies_each_message_exactly_once() {
    let env = Env::default();
    let (admin, client, user, recipient) = setup_bridge(&env);
    client.set_daily_cap(&admin, &STELLAR, &1_000);

    let first = client.lock(&user, &100, &ETHEREUM, &recipient);
    let second = client.lock(&user, &200, &ETHEREUM, &recipient);
    let third = client.lock(&user, &300, &ETHEREUM, &recipient);

    // A message for an operation that was never locked is rejected.
    assert_eq!(
        client.try_mint(&Symbol::new(&env, "99"), &recipient, &100, &STELLAR),
        Err(Ok(BridgeError::OperationNotFound))
    );

    // Deliver 3, 1, 2 — operations are independent of delivery order.
    client.mint(&third, &recipient, &300, &STELLAR);
    client.mint(&first, &recipient, &100, &STELLAR);
    client.mint(&second, &recipient, &200, &STELLAR);
    assert_eq!(client.get_state().total_minted, 600);
    assert_eq!(client.get_volume_window(&STELLAR).volume, 600);

    // Late redelivery of every message, in yet another order, is rejected.
    for (id, amount) in [(second, 200), (third, 300), (first, 100)] {
        assert_eq!(
            client.try_mint(&id, &recipient, &amount, &STELLAR),
            Err(Ok(BridgeError::AlreadyProcessed))
        );
    }
    assert_eq!(client.get_state().total_minted, 600);
    assert_eq!(client.get_volume_window(&STELLAR).volume, 600);
}

#[test]
fn a_rejected_attempt_does_not_consume_the_message_but_a_success_does() {
    let env = Env::default();
    let (_admin, client, user, recipient) = setup_bridge(&env);
    let attacker = Address::generate(&env);

    let operation_id = client.lock(&user, &100, &ETHEREUM, &recipient);

    // A forged first delivery (wrong recipient) fails without marking the
    // operation processed, so the genuine message is not locked out...
    assert_eq!(
        client.try_mint(&operation_id, &attacker, &100, &STELLAR),
        Err(Ok(BridgeError::InvalidRecipient))
    );
    assert_eq!(client.get_state().total_minted, 0);

    // ...the genuine delivery applies once...
    client.mint(&operation_id, &recipient, &100, &STELLAR);
    assert_eq!(client.get_state().total_minted, 100);

    // ...and any further delivery is a replay.
    assert_eq!(
        client.try_mint(&operation_id, &recipient, &100, &STELLAR),
        Err(Ok(BridgeError::AlreadyProcessed))
    );
    assert_eq!(client.get_state().total_minted, 100);
}
