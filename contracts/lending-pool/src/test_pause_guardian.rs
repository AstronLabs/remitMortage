// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{has_event, setup};
use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

#[test]
fn guardian_can_pause_and_admin_can_rotate_and_unpause() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    let guardian1 = Address::generate(&env);
    let guardian2 = Address::generate(&env);

    // Without a guardian configured, pause_as_guardian returns Unauthorized.
    assert_eq!(client.try_pause_as_guardian(), Err(Ok(PoolError::Unauthorized)));

    // Admin sets guardian1.
    client.set_pause_guardian(&guardian1);
    assert!(has_event(&env, "guardian_set"));
    assert_eq!(client.get_pause_guardian(), Some(guardian1.clone()));

    // Guardian1 pauses the pool immediately and emits guardian_pause.
    client.pause_as_guardian();
    assert!(has_event(&env, "guardian_pause"));
    assert!(client.is_paused());

    // Admin unpauses and rotates to guardian2.
    client.unpause();
    assert!(!client.is_paused());
    client.set_pause_guardian(&guardian2);
    assert!(has_event(&env, "guardian_set"));
    assert_eq!(client.get_pause_guardian(), Some(guardian2.clone()));

    // Admin clears guardian.
    client.clear_pause_guardian();
    assert!(has_event(&env, "guardian_clr"));
    assert_eq!(client.get_pause_guardian(), None);
}

#[test]
fn guardian_cannot_unpause_or_call_privileged_admin_functions() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    let guardian = Address::generate(&env);
    client.set_pause_guardian(&guardian);

    // Clear mock_all_auths by providing explicit guardian-only auth for each call.
    // 1. Guardian CAN call pause_as_guardian.
    client
        .mock_auths(&[MockAuth {
            address: &guardian,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "pause_as_guardian",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .pause_as_guardian();
    assert!(client.is_paused());

    // 2. Guardian CANNOT call unpause.
    let unpause_res = client
        .mock_auths(&[MockAuth {
            address: &guardian,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "unpause",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_unpause();
    assert!(unpause_res.is_err());
    assert!(client.is_paused());

    // 3. Guardian CANNOT change origination fee.
    let fee_res = client
        .mock_auths(&[MockAuth {
            address: &guardian,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_origination_fee_bps",
                args: (100u32,).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_origination_fee_bps(&100u32);
    assert!(fee_res.is_err());

    // 4. Guardian CANNOT rotate guardian.
    let other = Address::generate(&env);
    let rotate_res = client
        .mock_auths(&[MockAuth {
            address: &guardian,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_pause_guardian",
                args: (other.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_set_pause_guardian(&other);
    assert!(rotate_res.is_err());
}
