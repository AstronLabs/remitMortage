// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
};

/// Ledger constant for compound/year calculations (6 months = 518,400 ledgers, 1 year = 1,036,800 ledgers).
const LEDGERS_PER_YEAR: u64 = 1_036_800;
const BPS_SCALE: u128 = 10_000;

/// Fixed-point scale used for compounding math (10^9).
const INTEREST_SCALE: i128 = 1_000_000_000i128;

/// Number of ledgers per compounding period. Interest compounds once per
/// whole period elapsed instead of as a single simple-interest lump sum
/// over however long happens to pass between calls, so more frequent
/// harvesting yields more (and more accurate) compounding.
#[cfg(not(test))]
const COMPOUND_PERIOD: u64 = 86_400; // ~1 month (LEDGERS_PER_YEAR / 12)
#[cfg(test)]
const COMPOUND_PERIOD: u64 = 10;

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    ApyBps,
    TotalShares,
    TotalAssets,
    LastAccrualLedger,
    ShareBalance(Address),
}

#[contract]
pub struct YieldVaultContract;

/// Internal helpers (not part of the public contract interface).
impl YieldVaultContract {
    /// Raise `base` (fixed-point, scale = `INTEREST_SCALE`) to the power
    /// `exp` via binary exponentiation, returning a fixed-point result at
    /// the same scale.
    fn compound_pow(base: i128, mut exp: u64) -> i128 {
        let scale = INTEREST_SCALE;
        let mut result = scale; // 1.0 in fixed-point
        let mut b = base;
        while exp > 0 {
            if exp & 1 == 1 {
                result = result.saturating_mul(b) / scale;
            }
            b = b.saturating_mul(b) / scale;
            exp >>= 1;
        }
        result
    }
}

#[contractimpl]
impl YieldVaultContract {
    /// Initialize the yield vault with a underlying token and annual yield (in bps, e.g. 500 = 5% APY).
    pub fn initialize(env: Env, admin: Address, token: Address, apy_bps: u32) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::ApyBps, &apy_bps);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        env.storage().instance().set(&DataKey::TotalAssets, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::LastAccrualLedger, &env.ledger().sequence());
    }

    /// Accrue interest based on whole compounding periods elapsed since
    /// last accrual.
    ///
    /// Rather than applying a single simple-interest lump sum over
    /// whatever span happens to have elapsed, this compounds the yield
    /// once per `COMPOUND_PERIOD` ledgers using binary exponentiation.
    /// Any leftover sub-period remainder is left un-advanced so it carries
    /// forward and is not lost on the next call.
    pub fn accrue_interest(env: &Env) {
        let current_ledger = env.ledger().sequence();
        let last_ledger: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LastAccrualLedger)
            .unwrap_or(current_ledger);

        if current_ledger <= last_ledger {
            return;
        }

        let elapsed = (current_ledger - last_ledger) as u64;
        let periods = elapsed / COMPOUND_PERIOD;
        if periods == 0 {
            // Bank the sub-period remainder for the next call instead of
            // discarding it.
            return;
        }

        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        let apy_bps: u32 = env
            .storage()
            .instance()
            .get(&DataKey::ApyBps)
            .unwrap_or(0);

        if total_assets > 0 && apy_bps > 0 {
            // Per-period rate = (apy_bps / BPS_SCALE) * (COMPOUND_PERIOD / LEDGERS_PER_YEAR),
            // expressed in INTEREST_SCALE fixed-point, then compounded
            // across `periods` whole periods.
            let period_rate_scaled = (apy_bps as i128)
                .saturating_mul(INTEREST_SCALE)
                .saturating_mul(COMPOUND_PERIOD as i128)
                / (BPS_SCALE as i128 * LEDGERS_PER_YEAR as i128);
            let factor = INTEREST_SCALE + period_rate_scaled;
            let compounded = Self::compound_pow(factor, periods);

            let new_total_assets = total_assets.saturating_mul(compounded) / INTEREST_SCALE;
            env.storage()
                .instance()
                .set(&DataKey::TotalAssets, &new_total_assets);
        }

        // Advance only by whole periods processed, keeping any sub-period
        // remainder banked for the next accrual.
        let new_last_ledger = last_ledger + (periods * COMPOUND_PERIOD) as u32;
        env.storage()
            .instance()
            .set(&DataKey::LastAccrualLedger, &new_last_ledger);
    }

    /// Force-accrue any pending yield right now and return the amount
    /// harvested this call (0 if less than a full compounding period has
    /// elapsed).
    ///
    /// This lets a single caller (a keeper, a cron job, or any depositor)
    /// pay the accrual cost once for the whole vault so every depositor's
    /// exchange rate (`total_assets` / `total_shares`) updates together,
    /// instead of each depositor needing their own deposit/withdraw
    /// transaction to trigger it. Calling it as often as a compounding
    /// period elapses maximizes compounding frequency.
    pub fn batch_harvest(env: Env) -> i128 {
        let assets_before: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);

        Self::accrue_interest(&env);

        let assets_after: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);
        let harvested = assets_after - assets_before;

        if harvested > 0 {
            let total_shares: i128 = env
                .storage()
                .instance()
                .get(&DataKey::TotalShares)
                .unwrap_or(0);
            env.events().publish(
                (symbol_short!("harvest"),),
                (harvested, assets_after, total_shares),
            );
        }

        harvested
    }

    /// Deposit USDC tokens from `from` address and mint vault shares.
    /// Interface expected by EscrowContract: `deposit(from: Address, amount: i128) -> i128`
    pub fn deposit(env: Env, from: Address, amount: i128) -> i128 {
        from.require_auth();
        if amount <= 0 {
            panic!("amount must be positive");
        }

        Self::accrue_interest(&env);

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(&env, &token_addr);

        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);

        let shares = if total_shares == 0 || total_assets == 0 {
            amount
        } else {
            ((amount as u128).saturating_mul(total_shares as u128)
                / total_assets as u128) as i128
        };

        if shares <= 0 {
            panic!("shares minted must be positive");
        }

        // Transfer underlying token from caller to vault
        token_client.transfer(&from, &env.current_contract_address(), &amount);

        // Update balances and totals
        let new_total_shares = total_shares + shares;
        let new_total_assets = total_assets + amount;

        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &new_total_shares);
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &new_total_assets);

        let caller_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::ShareBalance(from.clone()))
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::ShareBalance(from.clone()), &(caller_shares + shares));

        env.events().publish(
            (symbol_short!("deposit"), from.clone()),
            (amount, shares),
        );

        shares
    }

    /// Withdraw shares and receive underlying USDC tokens (plus accrued yield).
    /// Interface expected by EscrowContract: `withdraw(to: Address, shares: i128) -> i128`
    pub fn withdraw(env: Env, to: Address, shares: i128) -> i128 {
        to.require_auth();
        if shares <= 0 {
            panic!("shares must be positive");
        }

        Self::accrue_interest(&env);

        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);

        if shares > total_shares {
            panic!("insufficient vault shares");
        }

        let amount = ((shares as u128).saturating_mul(total_assets as u128)
            / total_shares as u128) as i128;

        let new_total_shares = total_shares - shares;
        let new_total_assets = total_assets - amount;

        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &new_total_shares);
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &new_total_assets);

        let caller_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::ShareBalance(to.clone()))
            .unwrap_or(0);
        if caller_shares < shares {
            panic!("insufficient share balance");
        }
        env.storage()
            .persistent()
            .set(&DataKey::ShareBalance(to.clone()), &(caller_shares - shares));

        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(&env, &token_addr);

        // Mint extra tokens directly to vault if vault balance is less than `amount` due to simulated interest
        let vault_balance = token_client.balance(&env.current_contract_address());
        if vault_balance < amount {
            let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
            let sac = token::StellarAssetClient::new(&env, &token_addr);
            sac.mint(&env.current_contract_address(), &(amount - vault_balance));
        }

        // Transfer underlying token + yield from vault to recipient `to`
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        env.events().publish(
            (symbol_short!("withdraw"), to.clone()),
            (shares, amount),
        );

        amount
    }

    /// Read current share balance of an address.
    pub fn get_shares(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::ShareBalance(account))
            .unwrap_or(0)
    }

    /// Read total assets managed by vault (including accrued interest).
    pub fn get_total_assets(env: Env) -> i128 {
        Self::accrue_interest(&env);
        env.storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0)
    }

    /// Read total shares minted.
    pub fn get_total_shares(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    /// Convert share amount to underlying token value.
    pub fn convert_to_assets(env: Env, shares: i128) -> i128 {
        Self::accrue_interest(&env);
        let total_shares: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0);
        let total_assets: i128 = env
            .storage()
            .instance()
            .get(&DataKey::TotalAssets)
            .unwrap_or(0);

        if total_shares == 0 {
            shares
        } else {
            ((shares as u128).saturating_mul(total_assets as u128)
                / total_shares as u128) as i128
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::token::StellarAssetClient;

    /// 1 USDC in stroops (7 decimals).
    const USDC: i128 = 10_000_000;
    /// Tolerance, in stroops, allowed for integer-rounding drift in
    /// proportional yield-sharing calculations.
    const STROOP_TOLERANCE: i128 = 1;

    fn setup(env: &Env, apy_bps: u32) -> (Address, Address, YieldVaultContractClient<'_>) {
        // `withdraw` mints simulated yield directly to the vault via the
        // token admin, a sub-invocation for an address that isn't part of
        // the top-level call — allow that non-root auth in tests.
        env.mock_all_auths_allowing_non_root_auth();

        let admin = Address::generate(env);
        let token_admin = Address::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin);
        let token = token_id.address();

        let vault_id = env.register(YieldVaultContract, ());
        let client = YieldVaultContractClient::new(env, &vault_id);
        client.initialize(&admin, &token, &apy_bps);

        (admin, token, client)
    }

    #[test]
    fn test_batch_harvest_no_op_within_a_period() {
        let env = Env::default();
        let (_admin, token, client) = setup(&env, 1000); // 10% APY
        let sac = StellarAssetClient::new(&env, &token);

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(10_000 * USDC));
        client.deposit(&depositor, &(10_000 * USDC));

        // No ledgers have elapsed since deposit's own accrual call, so a
        // harvest right away should be a no-op.
        let harvested = client.batch_harvest();
        assert_eq!(harvested, 0);
    }

    #[test]
    fn test_batch_harvest_accrues_and_updates_exchange_rate() {
        let env = Env::default();
        let (_admin, token, client) = setup(&env, 1000); // 10% APY
        let sac = StellarAssetClient::new(&env, &token);

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(10_000 * USDC));
        client.deposit(&depositor, &(10_000 * USDC));

        let rate_before = client.convert_to_assets(&USDC);

        // Advance several whole compounding periods.
        env.ledger().with_mut(|l| {
            l.sequence_number += (COMPOUND_PERIOD as u32) * 5;
        });

        let harvested = client.batch_harvest();
        assert!(harvested > 0, "expected positive yield to be harvested");
        assert_eq!(client.get_total_assets(), 10_000 * USDC + harvested);

        // The exchange rate (assets per share) must have increased and a
        // second harvest immediately after should be a no-op (all pending
        // whole periods were already pooled into the first call).
        let rate_after = client.convert_to_assets(&USDC);
        assert!(rate_after > rate_before);
        assert_eq!(client.batch_harvest(), 0);
    }

    #[test]
    fn test_yield_shared_proportionally_across_equal_depositors() {
        let env = Env::default();
        let (_admin, token, client) = setup(&env, 800); // 8% APY
        let sac = StellarAssetClient::new(&env, &token);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        sac.mint(&alice, &(5_000 * USDC));
        sac.mint(&bob, &(5_000 * USDC));

        // Equal deposits at the same exchange rate mint equal shares.
        client.deposit(&alice, &(5_000 * USDC));
        client.deposit(&bob, &(5_000 * USDC));
        assert_eq!(client.get_shares(&alice), client.get_shares(&bob));

        env.ledger().with_mut(|l| {
            l.sequence_number += (COMPOUND_PERIOD as u32) * 3;
        });

        let harvested = client.batch_harvest();
        assert!(harvested > 0);

        let alice_value = client.convert_to_assets(&client.get_shares(&alice));
        let bob_value = client.convert_to_assets(&client.get_shares(&bob));

        // Equal shares must receive equal yield without any lockup or
        // preferential claim, within integer-rounding tolerance.
        assert!((alice_value - bob_value).abs() <= STROOP_TOLERANCE);

        // The pooled harvest must be fully attributable to depositors: the
        // sum of individual claims matches total vault assets within one
        // stroop of rounding drift.
        let total_assets = client.get_total_assets();
        assert!((alice_value + bob_value - total_assets).abs() <= STROOP_TOLERANCE);
    }

    #[test]
    fn test_yield_shared_proportionally_across_unequal_depositors() {
        let env = Env::default();
        let (_admin, token, client) = setup(&env, 1200); // 12% APY
        let sac = StellarAssetClient::new(&env, &token);

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        sac.mint(&alice, &(10_000 * USDC));
        sac.mint(&bob, &(10_000 * USDC));

        // Alice deposits 3x what Bob deposits, both before any yield accrues.
        client.deposit(&alice, &(9_000 * USDC));
        client.deposit(&bob, &(3_000 * USDC));

        env.ledger().with_mut(|l| {
            l.sequence_number += (COMPOUND_PERIOD as u32) * 4;
        });

        client.batch_harvest();

        let alice_value = client.convert_to_assets(&client.get_shares(&alice));
        let bob_value = client.convert_to_assets(&client.get_shares(&bob));

        // Alice's claim must stay proportional (3x Bob's) — no depositor is
        // diluted or favored by the batched harvest — within rounding
        // tolerance from the integer share-price division.
        let expected_alice = bob_value.saturating_mul(3);
        assert!((alice_value - expected_alice).abs() <= STROOP_TOLERANCE * 3);

        let total_assets = client.get_total_assets();
        assert!((alice_value + bob_value - total_assets).abs() <= STROOP_TOLERANCE);
    }

    #[test]
    fn test_depositor_can_withdraw_immediately_without_lockup() {
        let env = Env::default();
        let (_admin, token, client) = setup(&env, 500); // 5% APY
        let sac = StellarAssetClient::new(&env, &token);

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(1_000 * USDC));
        client.deposit(&depositor, &(1_000 * USDC));

        env.ledger().with_mut(|l| {
            l.sequence_number += (COMPOUND_PERIOD as u32) * 2;
        });
        client.batch_harvest();

        // No lockup: a depositor can withdraw all their shares right after
        // a batch harvest and receive their proportional (grown) value.
        let shares = client.get_shares(&depositor);
        let withdrawn = client.withdraw(&depositor, &shares);
        assert!(withdrawn > 1_000 * USDC);
        assert_eq!(client.get_shares(&depositor), 0);
    }
}
