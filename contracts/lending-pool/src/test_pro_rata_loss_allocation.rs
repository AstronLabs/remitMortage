// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, Ledger as _},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Symbol,
};

/// Mock escrow contract that returns a configurable partial-recovery amount
/// (and transfers those tokens to the lending pool) when collateral is seized
/// on default.
#[contract]
struct PartialRecoveryEscrow;

#[contractimpl]
impl PartialRecoveryEscrow {
    pub fn configure(env: Env, token: Address, recovery_amount: i128) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "token"), &token);
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "recovery"), &recovery_amount);
    }

    pub fn seize_collateral(
        env: Env,
        _borrower: Address,
        lending_pool_address: Address,
    ) -> i128 {
        let recovery: i128 = env
            .storage()
            .instance()
            .get(&Symbol::new(&env, "recovery"))
            .unwrap_or(0);
        if recovery > 0 {
            let token: Address = env
                .storage()
                .instance()
                .get(&Symbol::new(&env, "token"))
                .unwrap();
            TokenClient::new(&env, &token).transfer(
                &env.current_contract_address(),
                &lending_pool_address,
                &recovery,
            );
        }
        recovery
    }
}

struct PartialDefaultHarness<'a> {
    token: Address,
    escrow_addr: Address,
    escrow_client: PartialRecoveryEscrowClient<'a>,
    pool: LendingPoolContractClient<'a>,
}

/// Initializes a 0%-interest pool wired to `PartialRecoveryEscrow` so that
/// defaulted debt equals disbursed principal exactly, isolating principal
/// recovery and pro-rata loss math.
fn setup_zero_rate_pool(env: &Env) -> PartialDefaultHarness<'_> {
    env.mock_all_auths_allowing_non_root_auth();
    env.ledger().with_mut(|li| {
        li.max_entry_ttl = 4_000_001;
        li.min_persistent_entry_ttl = 4_000_000;
    });

    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(env))
        .address();
    let escrow_addr = env.register(PartialRecoveryEscrow, ());
    let escrow_client = PartialRecoveryEscrowClient::new(env, &escrow_addr);
    let pool = LendingPoolContractClient::new(env, &env.register(LendingPoolContract, ()));
    pool.initialize(
        &admin,
        &token,
        &escrow_addr,
        &0u32,
        &0u32,
        &treasury,
        &0u32,
        &0u32,
    );

    PartialDefaultHarness {
        token,
        escrow_addr,
        escrow_client,
        pool,
    }
}

fn deposit_investor(
    env: &Env,
    h: &PartialDefaultHarness<'_>,
    amount: i128,
    tranche: Tranche,
) -> Address {
    let investor = Address::generate(env);
    StellarAssetClient::new(env, &h.token).mint(&investor, &amount);
    h.pool.deposit(&investor, &amount, &tranche);
    investor
}

fn originate_and_default_with_recovery(
    env: &Env,
    h: &PartialDefaultHarness<'_>,
    principal: i128,
    recovered_amount: i128,
    loan_byte: u8,
) {
    let borrower = Address::generate(env);
    let loan_id = BytesN::from_array(env, &[loan_byte; 32]);
    h.pool.request_loan(&borrower, &loan_id, &principal);
    h.pool.approve_loan(&loan_id);
    h.pool.add_contractor(&borrower);
    h.pool.disburse(&loan_id, &borrower, &principal);

    if recovered_amount > 0 {
        StellarAssetClient::new(env, &h.token).mint(&h.escrow_addr, &recovered_amount);
    }
    h.escrow_client.configure(&h.token, &recovered_amount);

    let schedule = h.pool.get_repayment_schedule(&loan_id).unwrap();
    env.ledger()
        .set_sequence_number(schedule.next_due_ledger + DEFAULT_OVERDUE_LEDGERS + 1);
    h.pool.mark_default(&loan_id);
}

#[test]
fn partial_defaults_across_recovery_rates_respect_tranche_order_and_pro_rata_shares() {
    // Test 0%, 25%, 50%, and 75% recovery on a 40_000_0000000 principal loan
    // backed by Junior = 20_000_0000000 (split 1:3 -> 5_000 / 15_000) and
    // Senior = 80_000_0000000 (split 1:2:5 -> 10_000 / 20_000 / 50_000).
    let principal = 40_000_0000000i128;
    let junior_deposits = [5_000_0000000i128, 15_000_0000000i128];
    let senior_deposits = [
        10_000_0000000i128,
        20_000_0000000i128,
        50_000_0000000i128,
    ];
    let junior_total: i128 = junior_deposits[0] + junior_deposits[1];
    let senior_total: i128 = senior_deposits[0] + senior_deposits[1] + senior_deposits[2];

    // (recovery_bps, expected_junior_loss, expected_senior_loss)
    let cases: [(i128, i128, i128, u8); 4] = [
        // 0% recovery -> 40_000 unrecovered: Junior absorbs 20_000, Senior absorbs 20_000
        (0, 20_000_0000000, 20_000_0000000, 0x01),
        // 25% recovery -> 30_000 unrecovered: Junior absorbs 20_000, Senior absorbs 10_000
        (2_500, 20_000_0000000, 10_000_0000000, 0x02),
        // 50% recovery -> 20_000 unrecovered: Junior absorbs 20_000, Senior absorbs 0
        (5_000, 20_000_0000000, 0, 0x03),
        // 75% recovery -> 10_000 unrecovered: Junior absorbs 10_000, Senior absorbs 0
        (7_500, 10_000_0000000, 0, 0x04),
    ];

    for (recovery_bps, expected_junior_loss, expected_senior_loss, loan_byte) in cases {
        let env = Env::default();
        let h = setup_zero_rate_pool(&env);

        let j0 = deposit_investor(&env, &h, junior_deposits[0], Tranche::Junior);
        let j1 = deposit_investor(&env, &h, junior_deposits[1], Tranche::Junior);
        let s0 = deposit_investor(&env, &h, senior_deposits[0], Tranche::Senior);
        let s1 = deposit_investor(&env, &h, senior_deposits[1], Tranche::Senior);
        let s2 = deposit_investor(&env, &h, senior_deposits[2], Tranche::Senior);

        let recovered = (principal * recovery_bps) / 10_000;
        let unrecovered = principal - recovered;

        originate_and_default_with_recovery(&env, &h, principal, recovered, loan_byte);

        // 1. Tranche waterfall order: Junior absorbs first, Senior only overflow.
        let junior_info = h.pool.get_tranche_info(&Tranche::Junior);
        let senior_info = h.pool.get_tranche_info(&Tranche::Senior);
        assert_eq!(junior_info.total_loss_absorbed, expected_junior_loss);
        assert_eq!(senior_info.total_loss_absorbed, expected_senior_loss);
        assert_eq!(
            junior_info.total_loss_absorbed + senior_info.total_loss_absorbed,
            unrecovered
        );

        // 2. Per-investor proportionality within each tranche.
        let j0_loss = h.pool.get_investor_absorbed_loss(&j0);
        let j1_loss = h.pool.get_investor_absorbed_loss(&j1);
        assert_eq!(j0_loss, (expected_junior_loss * junior_deposits[0]) / junior_total);
        assert_eq!(j1_loss, (expected_junior_loss * junior_deposits[1]) / junior_total);

        let s0_loss = h.pool.get_investor_absorbed_loss(&s0);
        let s1_loss = h.pool.get_investor_absorbed_loss(&s1);
        let s2_loss = h.pool.get_investor_absorbed_loss(&s2);
        assert_eq!(s0_loss, (expected_senior_loss * senior_deposits[0]) / senior_total);
        assert_eq!(s1_loss, (expected_senior_loss * senior_deposits[1]) / senior_total);
        assert_eq!(s2_loss, (expected_senior_loss * senior_deposits[2]) / senior_total);

        // 3. Exact sum conservation across all investors (zero remainder here).
        let sum_investor_losses = j0_loss + j1_loss + s0_loss + s1_loss + s2_loss;
        assert_eq!(sum_investor_losses, unrecovered);
    }
}

#[test]
fn partial_default_with_sub_unit_remainder_keeps_remainder_in_pool_without_loss() {
    // Three equal investors in Junior (10_000_0000000 each = 30_000_0000000)
    // and three equal investors in Senior (20_000_0000000 each = 60_000_0000000).
    //
    // Case A: Junior-only absorption with ~1/3 recovery leaving an indivisible
    // unrecovered loss (remainder = 1 stroop) across 3 equal Junior investors.
    {
        let env = Env::default();
        let h = setup_zero_rate_pool(&env);

        let j0 = deposit_investor(&env, &h, 100_000_000_000i128, Tranche::Junior);
        let j1 = deposit_investor(&env, &h, 100_000_000_000i128, Tranche::Junior);
        let j2 = deposit_investor(&env, &h, 100_000_000_000i128, Tranche::Junior);
        let s0 = deposit_investor(&env, &h, 200_000_000_000i128, Tranche::Senior);
        let s1 = deposit_investor(&env, &h, 200_000_000_000i128, Tranche::Senior);
        let s2 = deposit_investor(&env, &h, 200_000_000_000i128, Tranche::Senior);

        let principal = 100_000_000_000i128;
        // ~33.3333333% recovery leaves 66_666_666_667 unrecovered (mod 3 == 1).
        let recovered = 33_333_333_333i128;
        let unrecovered = principal - recovered; // 66_666_666_667

        originate_and_default_with_recovery(&env, &h, principal, recovered, 0x21);

        let junior_info = h.pool.get_tranche_info(&Tranche::Junior);
        let senior_info = h.pool.get_tranche_info(&Tranche::Senior);
        assert_eq!(junior_info.total_loss_absorbed, unrecovered);
        assert_eq!(senior_info.total_loss_absorbed, 0);

        let j0_loss = h.pool.get_investor_absorbed_loss(&j0);
        let j1_loss = h.pool.get_investor_absorbed_loss(&j1);
        let j2_loss = h.pool.get_investor_absorbed_loss(&j2);
        assert_eq!(j0_loss, 22_222_222_222i128);
        assert_eq!(j1_loss, 22_222_222_222i128);
        assert_eq!(j2_loss, 22_222_222_222i128);

        assert_eq!(h.pool.get_investor_absorbed_loss(&s0), 0);
        assert_eq!(h.pool.get_investor_absorbed_loss(&s1), 0);
        assert_eq!(h.pool.get_investor_absorbed_loss(&s2), 0);

        let investor_sum = j0_loss + j1_loss + j2_loss;
        let pool_remainder = junior_info.total_loss_absorbed - investor_sum;
        assert_eq!(pool_remainder, 1i128);
        assert_eq!(investor_sum + pool_remainder, unrecovered);
    }

    // Case B: Junior exhausted and Senior absorbs spillover with a sub-unit
    // remainder (2 stroops) across 3 equal Senior investors.
    {
        let env = Env::default();
        let h = setup_zero_rate_pool(&env);

        let j0 = deposit_investor(&env, &h, 50_000_000_000i128, Tranche::Junior);
        let j1 = deposit_investor(&env, &h, 50_000_000_000i128, Tranche::Junior);
        let s0 = deposit_investor(&env, &h, 200_000_000_000i128, Tranche::Senior);
        let s1 = deposit_investor(&env, &h, 200_000_000_000i128, Tranche::Senior);
        let s2 = deposit_investor(&env, &h, 200_000_000_000i128, Tranche::Senior);

        let principal = 250_000_000_000i128;
        // ~20% recovery leaves 200_000_000_001 unrecovered:
        // Junior absorbs 100_000_000_000 (50_000_000_000 each),
        // Senior absorbs 100_000_000_001 (mod 3 == 2 -> 33_333_333_333 each + 2 remainder).
        let recovered = 49_999_999_999i128;
        let unrecovered = principal - recovered; // 200_000_000_001

        originate_and_default_with_recovery(&env, &h, principal, recovered, 0x22);

        let junior_info = h.pool.get_tranche_info(&Tranche::Junior);
        let senior_info = h.pool.get_tranche_info(&Tranche::Senior);
        assert_eq!(junior_info.total_loss_absorbed, 100_000_000_000i128);
        assert_eq!(senior_info.total_loss_absorbed, 100_000_000_001i128);
        assert_eq!(
            junior_info.total_loss_absorbed + senior_info.total_loss_absorbed,
            unrecovered
        );

        let j0_loss = h.pool.get_investor_absorbed_loss(&j0);
        let j1_loss = h.pool.get_investor_absorbed_loss(&j1);
        assert_eq!(j0_loss, 50_000_000_000i128);
        assert_eq!(j1_loss, 50_000_000_000i128);

        let s0_loss = h.pool.get_investor_absorbed_loss(&s0);
        let s1_loss = h.pool.get_investor_absorbed_loss(&s1);
        let s2_loss = h.pool.get_investor_absorbed_loss(&s2);
        assert_eq!(s0_loss, 33_333_333_333i128);
        assert_eq!(s1_loss, 33_333_333_333i128);
        assert_eq!(s2_loss, 33_333_333_333i128);

        let investor_sum = j0_loss + j1_loss + s0_loss + s1_loss + s2_loss;
        let pool_remainder =
            (junior_info.total_loss_absorbed + senior_info.total_loss_absorbed) - investor_sum;
        assert_eq!(pool_remainder, 2i128);
        assert_eq!(investor_sum + pool_remainder, unrecovered);
    }
}
