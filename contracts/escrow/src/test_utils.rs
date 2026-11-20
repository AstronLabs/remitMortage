// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use soroban_sdk::testutils::Ledger as _;

/// Advances the env.ledger().sequence() by `count`.
pub fn advance_ledger_sequence(env: &Env, count: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += count;
    });
}

/// Advances the env.ledger().timestamp() by `seconds`.
pub fn advance_ledger_time(env: &Env, seconds: u64) {
    env.ledger().with_mut(|li| {
        li.timestamp += seconds;
    });
}

use soroban_sdk::{contract, contractimpl, symbol_short, token, Address, Env};

/// Minimal stand-in for the real `yield-vault` contract, used to exercise the
/// escrow's holding-yield accounting without pulling the whole vault crate in
/// as a dev-dependency.
///
/// It custodies the deposited tokens and pays out a fixed 10% "yield" on
/// withdrawal, minting the shortfall via the token admin exactly like the real
/// vault does. Tests must call [`MockYieldVault::init`] with the underlying
/// token before use, and run with `Env::mock_all_auths_allowing_non_root_auth`
/// so the internal mint is authorised.
#[contract]
pub struct MockYieldVault;

#[contractimpl]
impl MockYieldVault {
    /// Record the underlying token this mock vault custodies.
    pub fn init(env: Env, token: Address) {
        env.storage()
            .instance()
            .set(&symbol_short!("token"), &token);
    }

    pub fn deposit(env: Env, from: Address, amount: i128) -> i128 {
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("token"))
            .unwrap();
        token::Client::new(&env, &token_addr).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );
        amount
    }

    pub fn withdraw(env: Env, to: Address, shares: i128) -> i128 {
        // Simulate 10% yield accrued while the shares were held.
        let total = shares + (shares / 10);
        let token_addr: Address = env
            .storage()
            .instance()
            .get(&symbol_short!("token"))
            .unwrap();
        let client = token::Client::new(&env, &token_addr);
        let balance = client.balance(&env.current_contract_address());
        if balance < total {
            token::StellarAssetClient::new(&env, &token_addr)
                .mint(&env.current_contract_address(), &(total - balance));
        }
        client.transfer(&env.current_contract_address(), &to, &total);
        total
    }
}
