// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for the claim-or-compound choice on investor yield.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, has_event, setup, Pool};
use soroban_sdk::{token::TokenClient, Env};

const UNIT: i128 = 1_0000000;

/// Routes `amount` of fee revenue into the pool as yield for depositors.
fn pay_yield(env: &Env, pool: &Pool<'_>, amount: i128) {
    let payer = funded(env, pool, amount);
    pool.client.deposit_fees(&payer, &amount);
}

fn balance(env: &Env, pool: &Pool<'_>, who: &Address) -> i128 {
    TokenClient::new(env, &pool.token).balance(who)
}

// ── Claim mode ──────────────────────────────────────────────────────────

#[test]
fn test_default_mode_is_claim() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    assert_eq!(pool.client.get_yield_mode(&a), YieldMode::Claim);
}

#[test]
fn test_claim_pays_yield_out_and_leaves_principal_unchanged() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    pay_yield(&env, &pool, 100 * UNIT);

    let before = balance(&env, &pool, &a);
    assert_eq!(pool.client.claim_yield(&a), 100 * UNIT);
    assert_eq!(balance(&env, &pool, &a) - before, 100 * UNIT);

    let info = pool.client.get_investor_info(&a);
    assert_eq!(info.deposited, 1_000 * UNIT, "principal is unchanged");
    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Senior)
            .total_deposited,
        1_000 * UNIT
    );
    // Nothing left to claim.
    assert_eq!(pool.client.claim_yield(&a), 0);
}

#[test]
fn test_compound_yield_is_a_noop_in_claim_mode() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    pay_yield(&env, &pool, 100 * UNIT);

    assert_eq!(pool.client.compound_yield(&a), 0);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_000 * UNIT);
    assert_eq!(pool.client.claim_yield(&a), 100 * UNIT);
}

// ── Compound mode ───────────────────────────────────────────────────────

#[test]
fn test_compound_increases_principal_in_the_same_tranche() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Junior);
    pool.client.set_yield_mode(&a, &YieldMode::Compound);
    pay_yield(&env, &pool, 100 * UNIT);

    let tokens_before = balance(&env, &pool, &a);
    assert_eq!(pool.client.compound_yield(&a), 100 * UNIT);
    assert!(has_event(&env, "y_comp"));

    let info = pool.client.get_investor_info(&a);
    assert_eq!(info.deposited, 1_100 * UNIT, "yield became principal");
    assert_eq!(info.tranche, Tranche::Junior);
    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Junior)
            .total_deposited,
        1_100 * UNIT
    );
    assert_eq!(pool.client.debt_balance(&a, &Tranche::Junior), 1_100 * UNIT);
    assert_eq!(
        pool.client.debt_total_supply(&Tranche::Junior),
        1_100 * UNIT
    );
    assert_eq!(
        balance(&env, &pool, &a),
        tokens_before,
        "compounding moves no tokens out"
    );

    // The same yield cannot be compounded twice.
    assert_eq!(pool.client.compound_yield(&a), 0);
    assert_eq!(pool.client.get_pending_yield(&a), 0);
}

#[test]
fn test_compounded_principal_earns_subsequent_yield() {
    let env = Env::default();
    let pool = setup(&env);
    let compounder = funded(&env, &pool, 1_000 * UNIT);
    let claimer = funded(&env, &pool, 1_000 * UNIT);
    pool.client
        .deposit(&compounder, &(1_000 * UNIT), &Tranche::Senior);
    pool.client
        .deposit(&claimer, &(1_000 * UNIT), &Tranche::Senior);
    pool.client
        .set_yield_mode(&compounder, &YieldMode::Compound);

    pay_yield(&env, &pool, 200 * UNIT);
    // Equal positions earn equal yield: 100 each.
    assert_eq!(pool.client.get_pending_yield(&compounder), 100 * UNIT);
    assert_eq!(pool.client.get_pending_yield(&claimer), 100 * UNIT);

    pool.client.compound_yield(&compounder);
    pool.client.claim_yield(&claimer);
    assert_eq!(
        pool.client.get_investor_info(&compounder).deposited,
        1_100 * UNIT
    );
    assert_eq!(
        pool.client.get_investor_info(&claimer).deposited,
        1_000 * UNIT
    );

    // The next round pays the larger position more.
    pay_yield(&env, &pool, 210 * UNIT);
    let compounder_next = pool.client.get_pending_yield(&compounder);
    let claimer_next = pool.client.get_pending_yield(&claimer);
    assert!(
        compounder_next > claimer_next,
        "compounded principal must earn more: {compounder_next} vs {claimer_next}"
    );
}

#[test]
fn test_claim_in_compound_mode_does_not_pay_fresh_yield() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    pool.client.set_yield_mode(&a, &YieldMode::Compound);
    pay_yield(&env, &pool, 100 * UNIT);

    let before = balance(&env, &pool, &a);
    assert_eq!(pool.client.claim_yield(&a), 0);
    assert_eq!(balance(&env, &pool, &a), before);
    // The yield is still there to compound.
    assert_eq!(pool.client.compound_yield(&a), 100 * UNIT);
}

// ── Switching ───────────────────────────────────────────────────────────

#[test]
fn test_switch_to_compound_applies_from_next_period() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);

    // Period 1 is earned while claiming.
    pay_yield(&env, &pool, 100 * UNIT);
    pool.client.set_yield_mode(&a, &YieldMode::Compound);
    assert!(has_event(&env, "y_mode"));

    // Switching must not turn period 1 into principal...
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_000 * UNIT);
    // ...it stays claimable cash.
    let before = balance(&env, &pool, &a);
    assert_eq!(pool.client.claim_yield(&a), 100 * UNIT);
    assert_eq!(balance(&env, &pool, &a) - before, 100 * UNIT);

    // Period 2 follows the new mode and compounds.
    pay_yield(&env, &pool, 50 * UNIT);
    assert_eq!(pool.client.compound_yield(&a), 50 * UNIT);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_050 * UNIT);
}

#[test]
fn test_switch_to_claim_cannot_cash_out_yield_earned_while_compounding() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    pool.client.set_yield_mode(&a, &YieldMode::Compound);

    pay_yield(&env, &pool, 100 * UNIT);
    // Flip to Claim before compounding: the 100 earned under Compound is
    // settled into principal, not paid out.
    pool.client.set_yield_mode(&a, &YieldMode::Claim);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_100 * UNIT);
    assert_eq!(pool.client.claim_yield(&a), 0);

    // Later yield is claimable again.
    pay_yield(&env, &pool, 30 * UNIT);
    assert_eq!(pool.client.claim_yield(&a), 30 * UNIT);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_100 * UNIT);
}

#[test]
fn test_switching_back_and_forth_in_one_period_is_neutral() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    pay_yield(&env, &pool, 100 * UNIT);

    pool.client.set_yield_mode(&a, &YieldMode::Compound);
    pool.client.set_yield_mode(&a, &YieldMode::Claim);
    pool.client.set_yield_mode(&a, &YieldMode::Compound);

    // The 100 earned while claiming is still exactly 100 of cash, once.
    assert_eq!(pool.client.claim_yield(&a), 100 * UNIT);
    assert_eq!(pool.client.claim_yield(&a), 0);
    assert_eq!(pool.client.get_investor_info(&a).deposited, 1_000 * UNIT);
}

#[test]
fn test_setting_the_same_mode_is_a_noop() {
    let env = Env::default();
    let pool = setup(&env);
    let a = funded(&env, &pool, 1_000 * UNIT);
    pool.client.deposit(&a, &(1_000 * UNIT), &Tranche::Senior);
    pay_yield(&env, &pool, 100 * UNIT);

    pool.client.set_yield_mode(&a, &YieldMode::Claim);
    assert_eq!(pool.client.get_pending_yield(&a), 100 * UNIT);
    assert_eq!(pool.client.claim_yield(&a), 100 * UNIT);
}

#[test]
fn test_set_yield_mode_requires_a_position() {
    let env = Env::default();
    let pool = setup(&env);
    let nobody = funded(&env, &pool, 10 * UNIT);
    let res = pool
        .client
        .try_set_yield_mode(&nobody, &YieldMode::Compound);
    assert_eq!(res.unwrap_err(), Ok(PoolError::InsufficientBalance));
}

// ── Seniority ───────────────────────────────────────────────────────────

#[test]
fn test_compounding_does_not_touch_the_other_tranche() {
    let env = Env::default();
    let pool = setup(&env);
    let senior = funded(&env, &pool, 1_000 * UNIT);
    let junior = funded(&env, &pool, 1_000 * UNIT);
    pool.client
        .deposit(&senior, &(1_000 * UNIT), &Tranche::Senior);
    pool.client
        .deposit(&junior, &(1_000 * UNIT), &Tranche::Junior);
    pool.client.set_yield_mode(&junior, &YieldMode::Compound);
    pay_yield(&env, &pool, 200 * UNIT);

    let senior_before = pool.client.get_tranche_info(&Tranche::Senior);
    let senior_pos_before = pool.client.get_investor_info(&senior);
    let senior_debt_before = pool.client.debt_total_supply(&Tranche::Senior);

    pool.client.compound_yield(&junior);

    // The senior tranche and the senior position are exactly as they were.
    assert_eq!(
        pool.client.get_tranche_info(&Tranche::Senior),
        senior_before
    );
    assert_eq!(pool.client.get_investor_info(&senior), senior_pos_before);
    assert_eq!(
        pool.client.debt_total_supply(&Tranche::Senior),
        senior_debt_before
    );
    // The junior tranche grew and the position stayed junior.
    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Junior)
            .total_deposited,
        1_100 * UNIT
    );
    assert_eq!(
        pool.client.get_investor_info(&junior).tranche,
        Tranche::Junior
    );
}

#[test]
fn test_senior_compounding_leaves_junior_tranche_untouched() {
    let env = Env::default();
    let pool = setup(&env);
    let senior = funded(&env, &pool, 1_000 * UNIT);
    let junior = funded(&env, &pool, 1_000 * UNIT);
    pool.client
        .deposit(&senior, &(1_000 * UNIT), &Tranche::Senior);
    pool.client
        .deposit(&junior, &(1_000 * UNIT), &Tranche::Junior);
    pool.client.set_yield_mode(&senior, &YieldMode::Compound);
    pay_yield(&env, &pool, 200 * UNIT);

    let junior_before = pool.client.get_tranche_info(&Tranche::Junior);
    pool.client.compound_yield(&senior);
    assert_eq!(
        pool.client.get_tranche_info(&Tranche::Junior),
        junior_before
    );
    assert_eq!(
        pool.client
            .get_tranche_info(&Tranche::Senior)
            .total_deposited,
        1_100 * UNIT
    );
}
