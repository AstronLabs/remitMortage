// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup};
use soroban_sdk::{
    contract, contractimpl,
    testutils::Address as _,
    Address, BytesN, Env,
};

#[contract]
pub struct MockInsurancePool;

#[contractimpl]
impl MockInsurancePool {
    pub fn set_reserves(env: Env, amount: i128) {
        env.storage()
            .instance()
            .set(&symbol_short!("reserves"), &amount);
    }

    pub fn get_reserves(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&symbol_short!("reserves"))
            .unwrap_or(0)
    }

    pub fn record_premium(env: Env, _from: Address, amount: i128) {
        let prev = Self::get_reserves(env.clone());
        env.storage()
            .instance()
            .set(&symbol_short!("reserves"), &(prev + amount));
    }
}

#[test]
fn proof_of_reserves_tracks_deposits_disbursements_repayments_defaults_and_insurance() {
    let env = Env::default();
    let pool = setup(&env);
    let client = &pool.client;

    // 1. Empty pool: 100% coverage ratio (10_000 bps)
    let empty = client.get_proof_of_reserves();
    assert_eq!(empty.token_balance, 0);
    assert_eq!(empty.total_investor_claims, 0);
    assert_eq!(empty.outstanding_loan_principal, 0);
    assert_eq!(empty.insurance_reserve, 0);
    assert_eq!(empty.coverage_ratio_bps, 10_000);
    assert_eq!(empty.ledger, env.ledger().sequence());

    // 2. Deposit: 100_000 into Senior
    let investor = funded(&env, &pool, 100_000);
    client.deposit(&investor, &100_000, &Tranche::Senior);

    let after_deposit = client.get_proof_of_reserves();
    assert_eq!(after_deposit.token_balance, 100_000);
    assert_eq!(after_deposit.total_investor_claims, 100_000);
    assert_eq!(after_deposit.outstanding_loan_principal, 0);
    assert_eq!(after_deposit.coverage_ratio_bps, 10_000);

    // 3. Wire mock insurance pool with 5_000 reserve
    let ins_id = env.register(MockInsurancePool, ());
    let ins_client = MockInsurancePoolClient::new(&env, &ins_id);
    ins_client.set_reserves(&5_000);
    client.set_insurance_pool(&ins_id);

    let with_ins = client.get_proof_of_reserves();
    assert_eq!(with_ins.insurance_reserve, 5_000);
    // (100_000 + 0 + 5_000) * 10_000 / 100_000 = 10_500 bps
    assert_eq!(with_ins.coverage_ratio_bps, 10_500);

    // 4. Disburse a 40_000 loan (5 bps insurance premium = 20 skimmed into insurance)
    let borrower = funded(&env, &pool, 60_000);
    let contractor = Address::generate(&env);
    client.add_contractor(&contractor);
    let loan_id = BytesN::from_array(&env, &[1u8; 32]);
    client.request_loan(&borrower, &loan_id, &40_000);
    client.approve_loan(&loan_id);
    client.disburse(&loan_id, &contractor, &40_000);

    let after_disburse = client.get_proof_of_reserves();
    assert_eq!(after_disburse.token_balance, 60_000);
    assert_eq!(after_disburse.outstanding_loan_principal, 40_000);
    assert_eq!(after_disburse.insurance_reserve, 5_020);
    assert_eq!(after_disburse.total_investor_claims, 100_000);
    let expected_ratio = ((60_000i128 + 40_000 + 5_020) * 10_000 / 100_000) as u32;
    assert_eq!(after_disburse.coverage_ratio_bps, expected_ratio);

    // 5. Partial repayment of 20_000
    client.repay(&borrower, &loan_id, &20_000);
    let after_repay = client.get_proof_of_reserves();
    assert_eq!(after_repay.token_balance, 80_000);
    assert_eq!(after_repay.outstanding_loan_principal, 20_000);
    assert_eq!(after_repay.total_investor_claims, 100_000);

    // 6. Default a second loan of 10_000 and verify losses reduce claims and outstanding principal
    let borrower2 = funded(&env, &pool, 10_000);
    let loan_id2 = BytesN::from_array(&env, &[2u8; 32]);
    client.request_loan(&borrower2, &loan_id2, &10_000);
    client.approve_loan(&loan_id2);
    client.disburse(&loan_id2, &contractor, &10_000);

    // Mark 3 missed installments on schedule so loan is eligible for default without 14 years of test compounding.
    env.as_contract(&client.address, || {
        let mut sched: RepaymentSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::LoanSchedule(loan_id2.clone()))
            .unwrap();
        sched.payments_missed = DEFAULT_MISSED_THRESHOLD;
        env.storage()
            .persistent()
            .set(&DataKey::LoanSchedule(loan_id2.clone()), &sched);
    });
    client.mark_default(&loan_id2);

    let after_default = client.get_proof_of_reserves();
    // Loan 2's 10_000 principal was written off; Loan 1 still has 20_000 principal outstanding.
    assert_eq!(after_default.outstanding_loan_principal, 20_000);
    assert_eq!(after_default.total_investor_claims, 90_000);
    let recomputed = ((after_default.token_balance
        + after_default.outstanding_loan_principal
        + after_default.insurance_reserve)
        * 10_000
        / after_default.total_investor_claims) as u32;
    assert_eq!(after_default.coverage_ratio_bps, recomputed);
}
