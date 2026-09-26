// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, BytesN, Env};

/// mark_default calls <escrow>.seize_collateral(...) for real (see the
/// crate-dependency note above `premium_for` in lib.rs), so any pool needs a
/// real registered contract at the escrow address, not a bare generated
/// Address. None of the loan-assumption tests reach mark_default, but this
/// keeps setup consistent with the rest of the test suite.
#[contract]
pub struct ZeroSeizureEscrow;

#[contractimpl]
impl ZeroSeizureEscrow {
    pub fn seize_collateral(_env: Env, _borrower: Address, _lending_pool_address: Address) -> i128 {
        0
    }
}

fn setup_pool_for_assumption<'a>(
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

    // Deploy a real stellar asset contract — a bare generated Address isn't
    // an actual token contract, so any transfer/mint against it fails with
    // "trying to get non-existing value for contract instance".
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

    (admin, investor, treasury, token_address, client)
}

#[test]
fn test_request_and_assume_loan_success() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, investor, _treasury, _token, client) = setup_pool_for_assumption(&env);
    let borrower_a = Address::generate(&env);
    let borrower_b = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[51u8; 32]);

    client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
    client.request_loan(&borrower_a, &loan_id, &50_000_0000000i128);
    client.approve_loan(&loan_id);

    // Initial loan owner is borrower_a
    let loan_before = client.get_loan_info(&loan_id);
    assert_eq!(loan_before.borrower, borrower_a);

    // Borrower A requests loan assumption for Borrower B
    client.request_loan_assumption(&loan_id, &borrower_b);
    let assumption = client.get_loan_assumption(&loan_id).unwrap();
    assert_eq!(assumption.current_borrower, borrower_a);
    assert_eq!(assumption.proposed_borrower, borrower_b);

    // Finalize assumption
    client.assume_loan(&loan_id, &borrower_b);

    // Verify ownership transferred to borrower_b and assumption request cleared
    let loan_after = client.get_loan_info(&loan_id);
    assert_eq!(loan_after.borrower, borrower_b);
    assert_eq!(client.get_loan_assumption(&loan_id), None);
}

#[test]
fn test_assume_loan_fails_unauthorized_borrower() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, investor, _treasury, _token, client) = setup_pool_for_assumption(&env);
    let borrower_a = Address::generate(&env);
    let borrower_b = Address::generate(&env);
    let borrower_c = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[52u8; 32]);

    client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
    client.request_loan(&borrower_a, &loan_id, &50_000_0000000i128);
    client.approve_loan(&loan_id);

    // Request assumption for Borrower B
    client.request_loan_assumption(&loan_id, &borrower_b);

    // Borrower C attempts to assume loan (not the designated proposed borrower)
    let res = client.try_assume_loan(&loan_id, &borrower_c);
    assert_eq!(
        res.err().unwrap().unwrap(),
        LoanAssumptionError::AssumptionNotAuthorized
    );
}

#[test]
fn test_cancel_loan_assumption_success() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, investor, _treasury, _token, client) = setup_pool_for_assumption(&env);
    let borrower_a = Address::generate(&env);
    let borrower_b = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[53u8; 32]);

    client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
    client.request_loan(&borrower_a, &loan_id, &50_000_0000000i128);
    client.approve_loan(&loan_id);

    client.request_loan_assumption(&loan_id, &borrower_b);
    assert!(client.get_loan_assumption(&loan_id).is_some());

    // Cancel assumption request
    client.cancel_loan_assumption(&loan_id);
    assert_eq!(client.get_loan_assumption(&loan_id), None);
}

#[test]
fn test_assume_loan_fails_not_active() {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();

    let (_admin, investor, _treasury, _token, client) = setup_pool_for_assumption(&env);
    let borrower_a = Address::generate(&env);
    let borrower_b = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[54u8; 32]);

    client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
    client.request_loan(&borrower_a, &loan_id, &50_000_0000000i128);

    // Loan not approved yet
    let res = client.try_request_loan_assumption(&loan_id, &borrower_b);
    assert_eq!(
        res.err().unwrap().unwrap(),
        LoanAssumptionError::LoanNotActive
    );
}
