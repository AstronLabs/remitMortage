// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Tests for `repay_batch`: one servicer paying several loans in a single
//! transaction, atomically, with one `repay` event per loan.

#![cfg(test)]

use super::*;
use crate::test_support::{funded, setup, Pool};
use soroban_sdk::{
    testutils::Events as _,
    token::Client as TokenClient,
    Address, BytesN, Env, Symbol, TryFromVal, Vec,
};

const UNIT: i128 = 1_0000000;
const PRINCIPAL: i128 = 10_000 * UNIT;
/// Well below an installment, so a payment of it is a plain partial payment.
const PAYMENT: i128 = 100 * UNIT;

fn originate(env: &Env, pool: &Pool<'_>, seed: u8) -> BytesN<32> {
    let borrower = funded(env, pool, PRINCIPAL);
    let loan_id = BytesN::from_array(env, &[seed; 32]);
    pool.client.request_loan(&borrower, &loan_id, &PRINCIPAL);
    pool.client.approve_loan(&loan_id);
    pool.client.add_contractor(&borrower);
    pool.client.disburse(&loan_id, &borrower, &PRINCIPAL);
    loan_id
}

/// A pool with `N` active loans (seeds 1..=N) and a funded servicer.
fn pool_with_loans<'a, const N: usize>(env: &'a Env) -> (Pool<'a>, Address, [BytesN<32>; N]) {
    let pool = setup(env);
    let investor = funded(env, &pool, PRINCIPAL * 10);
    pool.client
        .deposit(&investor, &(PRINCIPAL * 10), &Tranche::Senior);
    let loans: [BytesN<32>; N] = core::array::from_fn(|i| originate(env, &pool, i as u8 + 1));
    let servicer = funded(env, &pool, PRINCIPAL * 5);
    (pool, servicer, loans)
}

fn item(loan_id: &BytesN<32>, amount: i128) -> BatchRepayItem {
    BatchRepayItem {
        loan_id: loan_id.clone(),
        amount,
    }
}

fn batch(env: &Env, items: &[BatchRepayItem]) -> Vec<BatchRepayItem> {
    let mut v = Vec::new(env);
    for i in items {
        v.push_back(i.clone());
    }
    v
}

/// How many versioned `repay` events the last call emitted.
fn repay_events(env: &Env) -> u32 {
    let repay = Symbol::new(env, "repay");
    env.events()
        .all()
        .iter()
        .filter(|(_, topics, _)| {
            // The versioned copy is `[name, version]`; the legacy copy is
            // `[name]`, so counting the former counts each event once.
            topics.len() == 2
                && topics
                    .get(0)
                    .and_then(|t| Symbol::try_from_val(env, &t).ok())
                    .map_or(false, |s| s == repay)
        })
        .count() as u32
}

#[test]
fn test_batch_applies_every_entry_and_emits_one_repay_event_per_loan() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<3>(&env);
    let token = TokenClient::new(&env, &pool.token);

    let amounts = [PAYMENT, 2 * PAYMENT, 3 * PAYMENT];
    let entries = batch(
        &env,
        &[
            item(&loans[0], amounts[0]),
            item(&loans[1], amounts[1]),
            item(&loans[2], amounts[2]),
        ],
    );
    let before = token.balance(&servicer);
    let applied = pool.client.repay_batch(&servicer, &entries);

    assert_eq!(applied, 3);
    for (loan, amount) in loans.iter().zip(amounts) {
        assert_eq!(pool.client.get_loan_info(loan).repaid, amount);
    }
    assert_eq!(token.balance(&servicer), before - amounts.iter().sum::<i128>());
    assert_eq!(repay_events(&env), 3, "one repay event per loan");
}

#[test]
fn test_batch_entry_matches_a_single_repayment() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<2>(&env);

    pool.client.repay(&servicer, &loans[0], &PAYMENT);
    pool.client
        .repay_batch(&servicer, &batch(&env, &[item(&loans[1], PAYMENT)]));

    let single = pool.client.get_loan_info(&loans[0]);
    let batched = pool.client.get_loan_info(&loans[1]);
    assert_eq!(single.repaid, batched.repaid);
    assert_eq!(single.outstanding_debt, batched.outstanding_debt);
}

#[test]
fn test_one_invalid_entry_applies_none() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<3>(&env);
    let token = TokenClient::new(&env, &pool.token);
    let before = token.balance(&servicer);

    // Two good entries followed by one that pays more than the loan owes.
    let entries = batch(
        &env,
        &[
            item(&loans[0], PAYMENT),
            item(&loans[1], PAYMENT),
            item(&loans[2], PRINCIPAL * 3),
        ],
    );
    let err = pool.client.try_repay_batch(&servicer, &entries);
    assert_eq!(err.err().unwrap().unwrap(), BatchRepayError::OverPayment);

    for loan in &loans {
        assert_eq!(pool.client.get_loan_info(loan).repaid, 0);
    }
    assert_eq!(token.balance(&servicer), before);
}

#[test]
fn test_invalid_amount_and_unknown_loan_are_rejected_whole() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<2>(&env);

    let zero = batch(&env, &[item(&loans[0], PAYMENT), item(&loans[1], 0)]);
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &zero)
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::InvalidAmount
    );

    let unknown = BytesN::from_array(&env, &[99u8; 32]);
    let missing = batch(&env, &[item(&loans[0], PAYMENT), item(&unknown, PAYMENT)]);
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &missing)
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::LoanNotFound
    );

    assert_eq!(pool.client.get_loan_info(&loans[0]).repaid, 0);
}

#[test]
fn test_repaid_loan_in_the_batch_is_rejected_whole() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<2>(&env);

    let owed = pool.client.get_loan_info(&loans[1]).outstanding_debt;
    let fee_headroom = owed; // plenty for the early-repayment fee
    let payer = funded(&env, &pool, owed + fee_headroom);
    pool.client.repay(&payer, &loans[1], &owed);
    assert_eq!(
        pool.client.get_loan_info(&loans[1]).status,
        LoanStatus::Repaid
    );

    let entries = batch(&env, &[item(&loans[0], PAYMENT), item(&loans[1], PAYMENT)]);
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &entries)
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::InvalidLoanState
    );
    assert_eq!(pool.client.get_loan_info(&loans[0]).repaid, 0);
}

#[test]
fn test_oversized_batch_is_rejected_with_a_clear_error() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<1>(&env);
    let max = pool.client.get_max_repay_batch_size();

    // One entry over the cap is refused before any entry is looked at.
    let mut over = Vec::new(&env);
    for n in 0..=max {
        over.push_back(item(&BytesN::from_array(&env, &[n as u8 + 50; 32]), PAYMENT));
    }
    assert_eq!(over.len(), max + 1);
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &over)
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::BatchTooLarge
    );

    // Exactly the cap is not too large: it fails on the unknown loans instead.
    let mut at_cap = Vec::new(&env);
    for n in 0..max {
        at_cap.push_back(item(&BytesN::from_array(&env, &[n as u8 + 50; 32]), PAYMENT));
    }
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &at_cap)
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::LoanNotFound
    );
    assert_eq!(pool.client.get_loan_info(&loans[0]).repaid, 0);
}

#[test]
fn test_duplicate_loan_ids_are_rejected_whole() {
    let env = Env::default();
    let (pool, servicer, loans) = pool_with_loans::<2>(&env);
    let token = TokenClient::new(&env, &pool.token);
    let before = token.balance(&servicer);

    let entries = batch(
        &env,
        &[
            item(&loans[0], PAYMENT),
            item(&loans[1], PAYMENT),
            item(&loans[0], PAYMENT),
        ],
    );
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &entries)
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::DuplicateLoan
    );
    assert_eq!(pool.client.get_loan_info(&loans[0]).repaid, 0);
    assert_eq!(pool.client.get_loan_info(&loans[1]).repaid, 0);
    assert_eq!(token.balance(&servicer), before);
}

#[test]
fn test_empty_batch_is_rejected() {
    let env = Env::default();
    let (pool, servicer, _loans) = pool_with_loans::<1>(&env);
    assert_eq!(
        pool.client
            .try_repay_batch(&servicer, &Vec::new(&env))
            .err()
            .unwrap()
            .unwrap(),
        BatchRepayError::EmptyBatch
    );
}
