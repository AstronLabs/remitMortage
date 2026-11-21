// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup};
use soroban_sdk::{testutils::Ledger as _, Env};

#[test]
fn withdrawal_rejected_before_grace_window_ends_and_allowed_after() {
    let env = Env::default();
    let pool = setup(&env);

    pool.client.set_withdrawal_grace_ledgers(&100u32);
    assert_eq!(pool.client.get_withdrawal_grace_ledgers(), 100u32);

    let inv = funded(&env, &pool, 10_000_0000000i128);
    let start_ledger = env.ledger().sequence();
    pool.client
        .deposit(&inv, &10_000_0000000i128, &Tranche::Senior);

    assert_eq!(pool.client.get_withdrawable_amount(&inv), 0);

    // Same ledger and 1 ledger before unlock must reject with LockupPeriodActive.
    assert_eq!(
        pool.client.try_withdraw(&inv, &1_000_0000000i128),
        Err(Ok(PoolError::LockupPeriodActive))
    );
    env.ledger().set_sequence_number(start_ledger + 99);
    assert_eq!(
        pool.client.try_withdraw(&inv, &1_000_0000000i128),
        Err(Ok(PoolError::LockupPeriodActive))
    );

    // At exactly start_ledger + 100 the grace window has elapsed.
    env.ledger().set_sequence_number(start_ledger + 100);
    assert_eq!(
        pool.client.get_withdrawable_amount(&inv),
        10_000_0000000i128
    );
    pool.client.withdraw(&inv, &4_000_0000000i128);
    assert_eq!(
        pool.client.get_investor_info(&inv).deposited,
        6_000_0000000i128
    );
}

#[test]
fn partial_withdrawal_only_touches_eligible_earlier_deposit() {
    let env = Env::default();
    let pool = setup(&env);

    pool.client.set_withdrawal_grace_ledgers(&100u32);
    let inv = funded(&env, &pool, 20_000_0000000i128);
    let t0 = env.ledger().sequence();

    // First deposit: 10,000 at t0 (unlocks at t0 + 100).
    pool.client
        .deposit(&inv, &10_000_0000000i128, &Tranche::Junior);

    // Second deposit: 5,000 at t0 + 80 (unlocks at t0 + 180).
    env.ledger().set_sequence_number(t0 + 80);
    pool.client
        .deposit(&inv, &5_000_0000000i128, &Tranche::Junior);

    // At t0 + 110, the first deposit (10,000) is eligible, while the second (5,000) is still locked.
    env.ledger().set_sequence_number(t0 + 110);
    assert_eq!(
        pool.client.get_withdrawable_amount(&inv),
        10_000_0000000i128
    );

    // Dipping into the locked second deposit must fail.
    assert_eq!(
        pool.client.try_withdraw(&inv, &11_000_0000000i128),
        Err(Ok(PoolError::LockupPeriodActive))
    );

    // Withdrawing 6,000 from the eligible portion succeeds and does not reset the remaining 4,000 eligible.
    pool.client.withdraw(&inv, &6_000_0000000i128);
    assert_eq!(
        pool.client.get_withdrawable_amount(&inv),
        4_000_0000000i128
    );
    pool.client.withdraw(&inv, &4_000_0000000i128);
    assert_eq!(pool.client.get_withdrawable_amount(&inv), 0);

    // Remaining 5,000 stays locked until t0 + 180, then becomes withdrawable.
    env.ledger().set_sequence_number(t0 + 179);
    assert_eq!(
        pool.client.try_withdraw(&inv, &1_000_0000000i128),
        Err(Ok(PoolError::LockupPeriodActive))
    );
    env.ledger().set_sequence_number(t0 + 180);
    assert_eq!(
        pool.client.get_withdrawable_amount(&inv),
        5_000_0000000i128
    );
    pool.client.withdraw(&inv, &5_000_0000000i128);
    assert_eq!(pool.client.get_investor_info(&inv).deposited, 0);
}
