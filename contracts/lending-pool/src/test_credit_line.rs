// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

/// mark_default calls <escrow>.seize_collateral(...) for real (see the
/// crate-dependency note above `premium_for` in lib.rs), so any pool needs a
/// real registered contract at the escrow address, not a bare generated
/// Address. None of the credit-line tests reach mark_default, but this keeps
/// setup consistent with the rest of the test suite.
#[contract]
pub struct ZeroSeizureEscrow;

#[contractimpl]
impl ZeroSeizureEscrow {
    pub fn seize_collateral(_env: Env, _borrower: Address, _lending_pool_address: Address) -> i128 {
        0
    }
}

fn setup_pool_for_credit_line<'a>(
    env: &'a Env,
) -> (
    Address,
    Address,
    Address,
    Address,
    LendingPoolContractClient<'a>,
) {
    let admin = Address::generate(env);
    let investor = Address::generate(env);
    let treasury = Address::generate(env);

    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_address = token_id.address();
    let sac = StellarAssetClient::new(env, &token_address);
    sac.mint(&investor, &1_000_000_0000000i128);

    let escrow = env.register(ZeroSeizureEscrow, ());

    let contract_id = env.register(LendingPoolContract, ());
    let client = LendingPoolContractClient::new(env, &contract_id);
    client.initialize(
        &admin,
        &token_address,
        &escrow,
        &800u32,
        &400u32,
        &treasury,
        &0u32,
        &0u32,
    );
    client.deposit(&investor, &500_000_0000000i128, &Tranche::Senior);

    (admin, investor, treasury, token_address, client)
}

/// Replicates `LendingPoolContract::accrue_credit_interest`'s exact
/// fixed-point arithmetic so tests can compute the expected drawn balance
/// after `periods` compounding periods, rather than hardcoding a value that
/// drifts out of sync with the formula.
fn compound_interest(principal: i128, rate_bps: u32, periods: u32) -> i128 {
    const INTEREST_SCALE: i128 = 1_000_000_000;
    const PERIODS_PER_YEAR: i128 = 12;
    let factor = INTEREST_SCALE + (rate_bps as i128 * INTEREST_SCALE) / (10_000 * PERIODS_PER_YEAR);
    let mut result = INTEREST_SCALE;
    let mut base = factor;
    let mut exp = periods;
    while exp > 0 {
        if exp & 1 == 1 {
            result = result.saturating_mul(base) / INTEREST_SCALE;
        }
        base = base.saturating_mul(base) / INTEREST_SCALE;
        exp >>= 1;
    }
    principal.saturating_mul(result) / INTEREST_SCALE
}

#[test]
fn test_open_credit_line_sets_limit_and_zero_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, _investor, _treasury, _token, client) = setup_pool_for_credit_line(&env);
    let borrower = Address::generate(&env);

    client.open_credit_line(&borrower, &10_000_0000000i128, &1200u32);

    let line = client.get_credit_line(&borrower).unwrap();
    assert_eq!(line.approved_limit, 10_000_0000000i128);
    assert_eq!(line.drawn_balance, 0);
    assert_eq!(line.interest_rate_bps, 1200u32);
}

#[test]
fn test_opening_second_credit_line_for_same_borrower_fails() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, _investor, _treasury, _token, client) = setup_pool_for_credit_line(&env);
    let borrower = Address::generate(&env);

    client.open_credit_line(&borrower, &10_000_0000000i128, &1200u32);
    let result = client.try_open_credit_line(&borrower, &5_000_0000000i128, &1200u32);
    assert_eq!(result, Err(Ok(PoolError::CreditLineAlreadyExists)));
}

#[test]
fn test_draw_and_repay_cycle_never_exceeds_limit() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, _investor, _treasury, token, client) = setup_pool_for_credit_line(&env);
    let borrower = Address::generate(&env);
    let token_client = token::Client::new(&env, &token);

    let limit = 10_000_0000000i128;
    client.open_credit_line(&borrower, &limit, &0u32);

    // First draw.
    client.draw_credit(&borrower, &4_000_0000000i128);
    let line = client.get_credit_line(&borrower).unwrap();
    assert_eq!(line.drawn_balance, 4_000_0000000i128);
    assert_eq!(token_client.balance(&borrower), 4_000_0000000i128);

    // Repay in full.
    client.repay_credit(&borrower, &4_000_0000000i128);
    let line = client.get_credit_line(&borrower).unwrap();
    assert_eq!(line.drawn_balance, 0);

    // Draw again, up to the full limit — proves the limit is restored after
    // a repayment rather than being a one-time allowance.
    client.draw_credit(&borrower, &limit);
    let line = client.get_credit_line(&borrower).unwrap();
    assert_eq!(line.drawn_balance, limit);

    // A further draw of even 1 stroop must fail: the limit is fully used.
    let result = client.try_draw_credit(&borrower, &1i128);
    assert_eq!(result, Err(Ok(PoolError::CreditLimitExceeded)));
}

#[test]
fn test_draw_exceeding_approved_limit_reverts() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, _investor, _treasury, _token, client) = setup_pool_for_credit_line(&env);
    let borrower = Address::generate(&env);

    client.open_credit_line(&borrower, &5_000_0000000i128, &1000u32);
    client.draw_credit(&borrower, &3_000_0000000i128);

    // 3,000 already drawn against a 5,000 limit leaves 2,000 available;
    // drawing 2,000.0000001 must fail rather than silently cap the draw.
    let result = client.try_draw_credit(&borrower, &2_000_0000001i128);
    assert_eq!(result, Err(Ok(PoolError::CreditLimitExceeded)));

    // Exactly the remaining headroom still succeeds.
    client.draw_credit(&borrower, &2_000_0000000i128);
    let line = client.get_credit_line(&borrower).unwrap();
    assert_eq!(line.drawn_balance, 5_000_0000000i128);
}

#[test]
fn test_repay_more_than_drawn_balance_reverts() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, _investor, _treasury, _token, client) = setup_pool_for_credit_line(&env);
    let borrower = Address::generate(&env);

    client.open_credit_line(&borrower, &5_000_0000000i128, &0u32);
    client.draw_credit(&borrower, &1_000_0000000i128);

    let result = client.try_repay_credit(&borrower, &1_000_0000001i128);
    assert_eq!(result, Err(Ok(PoolError::OverPayment)));
}

#[test]
fn test_interest_accrues_only_against_drawn_balance() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, _investor, _treasury, _token, client) = setup_pool_for_credit_line(&env);
    let borrower = Address::generate(&env);

    // 12% annual rate, compounding monthly (COMPOUND_PERIOD = 100 ledgers in test builds).
    let rate_bps = 1200u32;
    client.open_credit_line(&borrower, &10_000_0000000i128, &rate_bps);
    client.draw_credit(&borrower, &2_000_0000000i128);

    // Advance 3 full compounding periods without any further draw or repay.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + 300);

    // A zero-amount probe isn't allowed, so trigger accrual via a tiny draw
    // against the now-larger balance and check the pre-draw accrued amount
    // indirectly: drawn_balance before this draw must already reflect 3
    // periods of compounding on the original 2,000 draw, independent of the
    // unused 8,000 of headroom.
    let expected_after_accrual = compound_interest(2_000_0000000i128, rate_bps, 3);
    let available_before_draw = 10_000_0000000i128 - expected_after_accrual;
    client.draw_credit(&borrower, &available_before_draw);

    let line = client.get_credit_line(&borrower).unwrap();
    assert_eq!(line.drawn_balance, 10_000_0000000i128);
}
