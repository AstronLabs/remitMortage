// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env};

fn sample_hash(env: &Env, byte: u8) -> BytesN<32> {
    BytesN::from_array(env, &[byte; 32])
}

#[test]
fn note_hash_set_at_creation_and_updatable_before_funding() {
    let env = Env::default();
    let pool = setup(&env);
    let inv = funded(&env, &pool, 50_000_0000000i128);
    pool.client
        .deposit(&inv, &50_000_0000000i128, &Tranche::Senior);

    let borrower = Address::generate(&env);
    let loan_id = sample_hash(&env, 0x01);
    let hash_v1 = sample_hash(&env, 0xAA);
    let hash_v2 = sample_hash(&env, 0xBB);

    pool.client.request_loan_with_note(
        &borrower,
        &loan_id,
        &10_000_0000000i128,
        &Some(hash_v1.clone()),
    );
    assert_eq!(pool.client.get_loan_note_hash(&loan_id), Some(hash_v1));

    // Updating before funding succeeds while the loan is still Requested.
    pool.client.set_loan_note_hash(&loan_id, &hash_v2);
    assert_eq!(pool.client.get_loan_note_hash(&loan_id), Some(hash_v2));
}

#[test]
fn note_hash_update_rejected_after_funding_and_absent_when_omitted() {
    let env = Env::default();
    let pool = setup(&env);
    let inv = funded(&env, &pool, 50_000_0000000i128);
    pool.client
        .deposit(&inv, &50_000_0000000i128, &Tranche::Senior);

    let borrower = Address::generate(&env);
    let loan_no_note = sample_hash(&env, 0x02);
    pool.client
        .request_loan(&borrower, &loan_no_note, &10_000_0000000i128);
    assert_eq!(pool.client.get_loan_note_hash(&loan_no_note), None);

    // Attach a hash while Requested, then approve and disburse (fund).
    let hash_initial = sample_hash(&env, 0xCC);
    pool.client
        .set_loan_note_hash(&loan_no_note, &hash_initial);
    pool.client.approve_loan(&loan_no_note);
    pool.client.add_contractor(&borrower);
    pool.client
        .disburse(&loan_no_note, &borrower, &10_000_0000000i128);

    // Mutating after funding must be rejected; hash stays immutable.
    let hash_tampered = sample_hash(&env, 0xDD);
    assert_eq!(
        pool.client
            .try_set_loan_note_hash(&loan_no_note, &hash_tampered),
        Err(Ok(PoolError::InvalidLoanState))
    );
    assert_eq!(
        pool.client.get_loan_note_hash(&loan_no_note),
        Some(hash_initial)
    );

    // All-zero hash is rejected.
    let loan_zero = sample_hash(&env, 0x03);
    assert_eq!(
        pool.client.try_request_loan_with_note(
            &borrower,
            &loan_zero,
            &5_000_0000000i128,
            &Some(sample_hash(&env, 0x00)),
        ),
        Err(Ok(PoolError::InvalidAmount))
    );
}
