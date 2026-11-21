// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Every event the escrow publishes carries its schema version as the last
//! topic, and (while `EMIT_LEGACY_EVENTS` is set) is also published in its
//! previous shape. The schema-drift guard lives in
//! `contracts/event-schemas/schema.cjs`.

#![cfg(test)]

use crate::events::EMIT_LEGACY_EVENTS;
use crate::types::EscrowConfig;
use crate::{EscrowContract, EscrowContractClient};
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    xdr::ScVal,
    Address, Env, TryFromVal, Val, Vec,
};

const CURRENT_VERSION: u32 = 1;

fn setup(env: &Env) -> EscrowContractClient<'_> {
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 2_000_000;
    });
    let client = EscrowContractClient::new(env, &env.register(EscrowContract, ()));
    client.initialize(&EscrowConfig {
        admin: Address::generate(env),
        token: Address::generate(env),
        lending_pool: Address::generate(env),
        savings_target: 10_000_0000000i128,
        max_duration_ledgers: 518_400u32,
        early_withdrawal_penalty_bps: 500u32,
        min_duration_ledgers: 0u32,
        penalty_bps_tier1: 500u32,
        penalty_bps_tier2: 300u32,
        penalty_bps_tier3: 150u32,
        penalty_bps_tier4: 50u32,
        grace_period_ledgers: 10u32,
        default_penalty_bps: 1000u32,
        instance_bump_amount: 1_000_000u32,
        instance_lifetime_threshold: 500_000u32,
        persistent_bump_amount: 1_000_000u32,
        persistent_lifetime_threshold: 500_000u32,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
        permissioned_mode: false,
    });
    client
}

fn scval(env: &Env, v: &Val) -> ScVal {
    ScVal::try_from_val(env, v).unwrap()
}

/// Checks every event the escrow emitted in the last call: each is a versioned
/// copy followed by its legacy copy, and the versioned copy is the legacy
/// topics plus the version. Returns how many events were checked.
fn assert_events_versioned(env: &Env, escrow: &EscrowContractClient<'_>) -> u32 {
    let all = env.events().all();
    let mut mine: Vec<u32> = Vec::new(env);
    for i in 0..all.len() {
        if all.get(i).unwrap().0 == escrow.address {
            mine.push_back(i);
        }
    }
    let step: u32 = if EMIT_LEGACY_EVENTS { 2 } else { 1 };
    assert_eq!(mine.len() % step, 0);

    let mut checked = 0;
    let mut n = 0;
    while n < mine.len() {
        let (_, topics, data) = all.get(mine.get(n).unwrap()).unwrap();
        let version = u32::try_from_val(env, &topics.last().unwrap())
            .expect("the last topic of every event is its schema version");
        assert_eq!(version, CURRENT_VERSION);

        if EMIT_LEGACY_EVENTS {
            let (_, legacy_topics, legacy_data) = all.get(mine.get(n + 1).unwrap()).unwrap();
            assert_eq!(topics.len(), legacy_topics.len() + 1);
            for i in 0..legacy_topics.len() {
                assert_eq!(
                    scval(env, &topics.get(i).unwrap()),
                    scval(env, &legacy_topics.get(i).unwrap())
                );
            }
            assert_eq!(scval(env, &data), scval(env, &legacy_data));
        }
        checked += 1;
        n += step;
    }
    checked
}

#[test]
fn events_carry_their_version_and_a_legacy_copy() {
    let env = Env::default();
    let escrow = setup(&env);

    escrow.set_permissioned_mode(&true);
    assert!(assert_events_versioned(&env, &escrow) > 0);

    let who = Address::generate(&env);
    escrow.add_to_whitelist(&who);
    assert!(assert_events_versioned(&env, &escrow) > 0);

    escrow.remove_from_whitelist(&who);
    assert!(assert_events_versioned(&env, &escrow) > 0);
}

/// No code path may publish an event around `emit_event`.
#[test]
fn production_code_publishes_only_through_emit_event() {
    for src in [include_str!("lib.rs"), include_str!("auto_deposit.rs")] {
        let production = src.split("mod test {").next().unwrap();
        assert!(!production.contains(".publish("));
        assert!(!production.contains("events()"));
    }
}
