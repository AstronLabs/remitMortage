// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Generic, interface-level compliance suite for [`BridgeAdapter`]
//! implementations.
//!
//! The suite drives `lock` / `mint` / `burn` **through the trait only**, so it
//! never depends on a concrete adapter's inherent API. Any adapter — the
//! shipped [`crate::StellarBridgeAdapter`] stub, or a future real bridge — can
//! be verified by calling [`assert_adapter_compliance`] with a closure that
//! deploys and initializes it.
//!
//! # Invariants asserted
//!
//! 1. A lock records exactly the locked amount and does not mint.
//! 2. Minting the resulting operation records exactly the locked amount, so
//!    `total_locked == total_minted` after a full cycle.
//! 3. Re-minting the same operation is refused (`AlreadyProcessed`) — no
//!    double-mint.
//! 4. Burning returns exactly the locked collateral, so after the cycle
//!    `total_burned == total_locked`.
//! 5. `verify_signature` rejects an operation that does not exist.
//!
//! # Plugging in a new adapter
//!
//! ```ignore
//! // In the new adapter crate (test or `#[cfg(test)]` module):
//! use bridge_adapter::compliance::assert_adapter_compliance;
//! # use bridge_adapter::{BridgeAdapter, BridgeError};
//! # struct MyAdapter;
//! # impl BridgeAdapter for MyAdapter { /* ... */ }
//! # fn setup(_env: &soroban_sdk::Env) -> soroban_sdk::Address { unimplemented!() }
//! let env = soroban_sdk::Env::default();
//! assert_adapter_compliance::<MyAdapter, _>(&env, setup);
//! ```
//!
//! `setup` must deploy the adapter, initialize it with `min_lock_amount <=
//! [`COMPLIANCE_AMOUNT`]`, `max_lock_amount >= [`COMPLIANCE_AMOUNT`]`, and
//! `ethereum` in the supported chain set, then return the contract address.
//! If an adapter needs the caller to hold a wrapped-asset balance (or any other
//! preconditions), grant them in `setup`; the suite calls `mock_all_auths`.

use soroban_sdk::{symbol_short, testutils::Address as _, Address, Env, Symbol};

use crate::{BridgeAdapter, BridgeError, BridgeState};

/// Amount used for the standard compliance lock/mint/burn cycle.
pub const COMPLIANCE_AMOUNT: i128 = 1_000;

/// Runs the shared lock/mint/burn compliance suite against adapter `A`.
///
/// Panics (failing the hosting test) if any interface invariant is violated.
/// See the module docs for the `setup` contract.
pub fn assert_adapter_compliance<A, F>(env: &Env, setup: F)
where
    A: BridgeAdapter,
    F: FnOnce(&Env) -> Address,
{
    env.mock_all_auths();
    let contract_id = setup(env);

    let user = Address::generate(env);
    let recipient = Address::generate(env);
    let destination = symbol_short!("ethereum");
    let source = symbol_short!("stellar");
    let amount = COMPLIANCE_AMOUNT;

    // ── lock ────────────────────────────────────────────────────────────────
    let lock_id = env
        .as_contract(&contract_id, || {
            <A as BridgeAdapter>::lock(env, &user, amount, &destination, &recipient)
        })
        .expect("lock must succeed for a valid amount on a supported chain");

    let state = state_of::<A>(env, &contract_id);
    assert_eq!(
        state.total_locked, amount,
        "lock must record the locked amount"
    );
    assert_eq!(state.total_minted, 0, "lock must not mint");

    // ── mint ────────────────────────────────────────────────────────────────
    env.as_contract(&contract_id, || {
        <A as BridgeAdapter>::mint(env, &lock_id, &recipient, amount, &source)
    })
    .expect("mint must succeed for the recorded operation");

    let state = state_of::<A>(env, &contract_id);
    assert_eq!(
        state.total_minted, amount,
        "minted amount must match the locked amount"
    );
    assert_eq!(
        state.total_locked, state.total_minted,
        "locked amount must equal minted amount after a full cycle"
    );

    // ── no double mint ──────────────────────────────────────────────────────
    let replay = env.as_contract(&contract_id, || {
        <A as BridgeAdapter>::mint(env, &lock_id, &recipient, amount, &source)
    });
    assert_eq!(
        replay,
        Err(BridgeError::AlreadyProcessed),
        "minting the same operation twice must be rejected"
    );

    // ── burn ────────────────────────────────────────────────────────────────
    let burn_id = env
        .as_contract(&contract_id, || {
            <A as BridgeAdapter>::burn(env, &user, amount, &destination, &recipient)
        })
        .expect("burn must succeed for a valid amount on a supported chain");
    assert_ne!(burn_id, lock_id, "burn must return a distinct operation id");

    let state = state_of::<A>(env, &contract_id);
    assert_eq!(
        state.total_burned, amount,
        "burn must return exactly the locked amount"
    );
    assert_eq!(
        state.total_locked, state.total_burned,
        "burn must return exactly the locked collateral"
    );

    // ── signature gate ──────────────────────────────────────────────────────
    let unknown = env.as_contract(&contract_id, || {
        <A as BridgeAdapter>::verify_signature(
            env,
            &symbol_short!("missing"),
            &symbol_short!("sig"),
        )
    });
    assert!(
        !unknown,
        "verify_signature must reject an unknown operation"
    );
}

fn state_of<A: BridgeAdapter>(env: &Env, contract_id: &Address) -> BridgeState {
    env.as_contract(contract_id, || <A as BridgeAdapter>::get_state(env))
}
