// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]
extern crate std;

use crate::{types::Tranche, LendingPoolContract, LendingPoolContractClient, PoolError};
use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, token::StellarAssetClient, Address, BytesN,
    Env,
};

/// mark_default calls <escrow>.seize_collateral(...) for real (see the
/// crate-dependency note above `premium_for` in lib.rs), so the fuzzed pool
/// needs a real registered contract at the escrow address, not a bare
/// generated Address.
#[contract]
pub struct ZeroSeizureEscrow;

#[contractimpl]
impl ZeroSeizureEscrow {
    pub fn seize_collateral(_env: Env, _borrower: Address, _lending_pool_address: Address) -> i128 {
        0
    }
}

fn setup_pool_with_rates(
    env: &Env,
    borrow_rate: u32,
    senior_rate: u32,
) -> (
    Address,
    Address,
    Address,
    Address,
    LendingPoolContractClient<'_>,
) {
    let admin = Address::generate(env);
    let investor = Address::generate(env);
    let treasury = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token_addr = token_id.address();
    let escrow = env.register(ZeroSeizureEscrow, ());

    let cid = env.register(LendingPoolContract, ());
    let client = LendingPoolContractClient::new(env, &cid);
    client.initialize(
        &admin,
        &token_addr,
        &escrow,
        &borrow_rate,
        &senior_rate,
        &treasury,
        &0u32,
        &0u32,
    );

    (admin, investor, treasury, token_addr, client)
}

proptest! {
    // 1. Random deposit/withdraw sequences maintain total_liquidity >= 0.
    #[test]
    fn deposit_withdraw_maintains_liquidity(
        actions in proptest::collection::vec(
            proptest::prop_oneof![
                Just(true),  // deposit
                Just(false), // withdraw
            ],
            1..20
        ),
        amounts in proptest::collection::vec(1i128..1_000_0000000i128, 1..20)
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, investor, _treasury, token_addr, client) = setup_pool_with_rates(&env, 800, 400);
        let sac = StellarAssetClient::new(&env, &token_addr);

        sac.mint(&investor, &100_000_000_0000000i128);

        for (is_deposit, amount) in actions.iter().zip(amounts.iter()) {
            if *is_deposit {
                client.deposit(&investor, amount, &Tranche::Senior);
            } else {
                let _ = client.try_withdraw(&investor, amount);
            }

            let health = client.get_pool_health();
            prop_assert!(health.total_liquidity >= 0, "total_liquidity must be >= 0");
        }
    }

    // 2. Interest calculation (principal * rate_bps) / 10_000 never overflows for realistic amounts.
    #[test]
    fn interest_calculation_no_overflow(
        principal in 1i128..1_000_000_000_0000000i128,
        rate_bps in 1u32..10_000u32,
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, investor, _treasury, token_addr, client) = setup_pool_with_rates(&env, rate_bps, 400);
        let sac = StellarAssetClient::new(&env, &token_addr);

        sac.mint(&investor, &1_000_000_000_0000000i128);
        client.deposit(&investor, &1_000_000_000_0000000i128, &Tranche::Senior);

        let borrower = Address::generate(&env);
        let loan_id = BytesN::from_array(&env, &[1; 32]);

        let result = client.try_request_loan(&borrower, &loan_id, &principal);
        prop_assert!(result.is_ok(), "request_loan should not overflow on interest calculation");
    }

    // 3. Repayment amounts never cause repaid > total_owed.
    #[test]
    fn repayment_never_exceeds_total_owed(
        repay_amounts in proptest::collection::vec(1i128..50_000_0000000i128, 1..5)
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, investor, _treasury, token_addr, client) = setup_pool_with_rates(&env, 800, 400);
        let sac = StellarAssetClient::new(&env, &token_addr);
        let borrower = Address::generate(&env);

        sac.mint(&investor, &100_000_0000000i128);
        sac.mint(&borrower, &100_000_0000000i128);
        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);

        let loan_id = BytesN::from_array(&env, &[2; 32]);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.add_contractor(&borrower);
        client.disburse(&loan_id, &borrower, &10_000_0000000i128);

        for amount in repay_amounts {
            let info_before = client.get_loan_info(&loan_id);
            let total_owed = info_before.outstanding_debt;

            let _ = client.try_repay(&borrower, &loan_id, &amount);

            let info_after = client.get_loan_info(&loan_id);
            let total_repaid = info_after.repaid;

            prop_assert!(total_repaid <= info_before.repaid + total_owed, "repaid must not exceed total_owed");
        }
    }

    // 4. Disburse amounts never exceed principal - already_disbursed.
    #[test]
    fn disburse_bounds(
        disburse_amounts in proptest::collection::vec(1i128..50_000_0000000i128, 1..5)
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, investor, _treasury, token_addr, client) = setup_pool_with_rates(&env, 800, 400);
        let sac = StellarAssetClient::new(&env, &token_addr);
        let borrower = Address::generate(&env);

        sac.mint(&investor, &100_000_0000000i128);
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);

        let loan_id = BytesN::from_array(&env, &[3; 32]);
        let principal = 50_000_0000000i128;
        client.request_loan(&borrower, &loan_id, &principal);
        client.approve_loan(&loan_id);

        for amount in disburse_amounts {
            let info_before = client.get_loan_info(&loan_id);
            let _ = client.try_disburse(&loan_id, &borrower, &amount);
            let info_after = client.get_loan_info(&loan_id);

            prop_assert!(info_after.disbursed <= principal, "disbursed must not exceed principal");
        }
    }

    // 5. Invariant Assertions: After any sequence of operations
    #[test]
    fn global_invariants_hold(
        actions in proptest::collection::vec(0u8..4u8, 1..15),
        amounts in proptest::collection::vec(1i128..10_000_0000000i128, 1..15)
    ) {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, investor, _treasury, token_addr, client) = setup_pool_with_rates(&env, 800, 400);
        let sac = StellarAssetClient::new(&env, &token_addr);

        sac.mint(&investor, &100_000_000_0000000i128);

        let borrower = Address::generate(&env);
        sac.mint(&borrower, &100_000_000_0000000i128);
        // disburse only pays out to whitelisted contractors; whitelist this
        // fixed borrower once so the disburse action (case 1) can succeed.
        client.add_contractor(&borrower);

        let mut loan_counter = 0u8;
        let mut current_loan_id = BytesN::from_array(&env, &[loan_counter; 32]);

        for (action, amount) in actions.iter().zip(amounts.iter()) {
            match action {
                0 => {
                    client.deposit(&investor, amount, &Tranche::Senior);
                },
                1 => {
                    if client.get_pool_health().total_liquidity >= *amount {
                        loan_counter += 1;
                        current_loan_id = BytesN::from_array(&env, &[loan_counter; 32]);
                        client.request_loan(&borrower, &current_loan_id, amount);
                        client.approve_loan(&current_loan_id);
                        client.disburse(&current_loan_id, &borrower, amount);
                    }
                },
                2 => {
                    if loan_counter > 0 {
                        let _ = client.try_repay(&borrower, &current_loan_id, amount);
                    }
                },
                3 => {
                    let _ = client.try_withdraw(&investor, amount);
                },
                _ => unreachable!()
            }

            let health = client.get_pool_health();
            prop_assert!(health.total_liquidity >= 0, "total_liquidity >= 0");
            prop_assert!(health.active_loan_commitments >= 0, "active_loan_commitments >= 0");
        }
    }
}
