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
    /// Redemption amount (underlying asset units) above which a withdrawal
    /// is queued instead of executed immediately. Absent (defaults to
    /// `i128::MAX`) means queuing is disabled — every existing deployment
    /// and test that never calls `set_withdrawal_threshold` keeps today's
    /// unconditional-immediate-withdrawal behavior via `withdraw`.
    WithdrawalThreshold,
    /// Token liquidity currently available to fulfill queued withdrawals —
    /// distinct from `TotalAssets`, which includes value already earmarked
    /// for queued-but-unfulfilled requests. Grows from new deposits and
    /// admin-reported matured positions; shrinks as immediate
    /// `request_withdrawal` calls and queue fulfillment consume it.
    AvailableLiquidity,
    /// Index of the oldest not-yet-fulfilled queue entry (FIFO front).
    QueueHead,
    /// Index the next enqueued entry will be assigned (FIFO back).
    QueueTail,
    /// One queued withdrawal request, keyed by its queue index.
    QueueEntry(u64),
}

/// A withdrawal request queued because it exceeded `WithdrawalThreshold` at
/// request time. `amount` is fixed at that moment (the exchange rate the
/// requester's shares were burned at), so further yield accrual while a
/// request waits in the queue never changes what it's owed.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct QueuedWithdrawal {
    pub id: u64,
    pub requester: Address,
    pub shares: i128,
    pub amount: i128,
    pub queued_ledger: u32,
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

    fn read_withdrawal_threshold(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::WithdrawalThreshold)
            .unwrap_or(i128::MAX)
    }

    fn read_available_liquidity(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::AvailableLiquidity)
            .unwrap_or(0)
    }

    /// Floors at zero — this counter is a bookkeeping gate for the queue,
    /// not a ledger that should ever go negative.
    fn set_available_liquidity(env: &Env, value: i128) {
        env.storage()
            .instance()
            .set(&DataKey::AvailableLiquidity, &value.max(0));
    }

    fn read_queue_head(env: &Env) -> u64 {
        env.storage().instance().get(&DataKey::QueueHead).unwrap_or(0)
    }

    fn read_queue_tail(env: &Env) -> u64 {
        env.storage().instance().get(&DataKey::QueueTail).unwrap_or(0)
    }

    /// Transfers `amount` of the underlying token to `to`, minting the
    /// shortfall first if the vault's own balance is short — the same
    /// simulated-yield-funding fallback `withdraw` already relies on.
    /// Shared by the legacy `withdraw`, `request_withdrawal`'s immediate
    /// path, and queue fulfillment so all three pay out identically.
    fn pay_out(env: &Env, to: &Address, amount: i128) {
        let token_addr: Address = env.storage().instance().get(&DataKey::Token).unwrap();
        let token_client = token::Client::new(env, &token_addr);

        let vault_balance = token_client.balance(&env.current_contract_address());
        if vault_balance < amount {
            let sac = token::StellarAssetClient::new(env, &token_addr);
            sac.mint(&env.current_contract_address(), &(amount - vault_balance));
        }

        token_client.transfer(&env.current_contract_address(), to, &amount);
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

        // A fresh deposit is immediately spendable liquidity for fulfilling
        // queued withdrawals — see the withdrawal-queue note above `withdraw`.
        let liquidity = Self::read_available_liquidity(&env);
        Self::set_available_liquidity(&env, liquidity + amount);

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
    ///
    /// # Withdrawal queue
    /// This function is deliberately left unconditional — it always executes
    /// immediately regardless of size, exactly as before — because its
    /// signature and synchronous-completion semantics are a fixed interface
    /// contract EscrowContract calls against. The large-redemption safety
    /// valve (`WithdrawalThreshold` / FIFO queue / `process_withdrawal_queue`)
    /// lives entirely in the new [Self::request_withdrawal], the entry point
    /// investors call directly. See the doc comment there for the invariant
    /// the queue maintains.
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

    /// Configure the redemption threshold (underlying asset units) above
    /// which [Self::request_withdrawal] queues instead of executing
    /// immediately. Admin-only. Must be positive — pass a very large value
    /// to effectively disable queuing rather than zero, which would queue
    /// every withdrawal including zero-amount ones.
    pub fn set_withdrawal_threshold(env: Env, admin: Address, threshold: i128) {
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if admin != stored_admin {
            panic!("unauthorized");
        }
        if threshold <= 0 {
            panic!("threshold must be positive");
        }

        env.storage()
            .instance()
            .set(&DataKey::WithdrawalThreshold, &threshold);

        env.events()
            .publish((symbol_short!("thresh"),), (admin, threshold));
    }

    /// Reports capital returned to the vault from a matured position (this
    /// toy vault has no real external investment to mature from, so this is
    /// the admin/keeper-facing hook standing in for that event) as newly
    /// available liquidity for the withdrawal queue. Admin-only.
    pub fn add_liquidity(env: Env, admin: Address, amount: i128) {
        let stored_admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        if admin != stored_admin {
            panic!("unauthorized");
        }
        if amount <= 0 {
            panic!("amount must be positive");
        }

        let liquidity = Self::read_available_liquidity(&env);
        let new_liquidity = liquidity + amount;
        Self::set_available_liquidity(&env, new_liquidity);

        env.events()
            .publish((symbol_short!("liq_add"),), (amount, new_liquidity));
    }

    /// Request a withdrawal, subject to the configured
    /// [Self::set_withdrawal_threshold]. Below (or equal to) the threshold,
    /// this behaves exactly like [Self::withdraw] and returns the amount
    /// paid out immediately. Above it, the shares are burned at today's
    /// exchange rate (so waiting in the queue never changes what's owed),
    /// the request is appended to the FIFO queue, a `w_queued` event is
    /// emitted, and this returns `0` — nothing has been paid out yet.
    /// Call [Self::process_withdrawal_queue] (anyone may call it, like
    /// [Self::batch_harvest]) to advance the queue as liquidity arrives.
    ///
    /// # Invariant
    /// A queued request is only ever fulfilled after every request ahead of
    /// it in the queue — strict FIFO. [Self::process_withdrawal_queue]
    /// enforces this by stopping at the first entry it can't fully cover,
    /// even if a smaller entry further back in the queue technically could
    /// be paid from the liquidity that remains.
    pub fn request_withdrawal(env: Env, to: Address, shares: i128) -> i128 {
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

        let caller_shares: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::ShareBalance(to.clone()))
            .unwrap_or(0);
        if caller_shares < shares {
            panic!("insufficient share balance");
        }

        let amount = ((shares as u128).saturating_mul(total_assets as u128)
            / total_shares as u128) as i128;

        // Burn the shares now regardless of which path this takes — the
        // exchange rate is locked in at request time either way.
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &(total_shares - shares));
        env.storage()
            .instance()
            .set(&DataKey::TotalAssets, &(total_assets - amount));
        env.storage()
            .persistent()
            .set(&DataKey::ShareBalance(to.clone()), &(caller_shares - shares));

        let threshold = Self::read_withdrawal_threshold(&env);

        if amount <= threshold {
            Self::pay_out(&env, &to, amount);

            let liquidity = Self::read_available_liquidity(&env);
            Self::set_available_liquidity(&env, liquidity - amount);

            env.events()
                .publish((symbol_short!("withdraw"), to), (shares, amount));

            return amount;
        }

        let id = Self::read_queue_tail(&env);
        let entry = QueuedWithdrawal {
            id,
            requester: to.clone(),
            shares,
            amount,
            queued_ledger: env.ledger().sequence(),
        };
        env.storage().persistent().set(&DataKey::QueueEntry(id), &entry);
        env.storage().instance().set(&DataKey::QueueTail, &(id + 1));

        env.events()
            .publish((symbol_short!("w_queued"), to), (id, shares, amount));

        0
    }

    /// Advances the FIFO withdrawal queue as far as available liquidity
    /// allows, paying out each entry in order and stopping at the first one
    /// it can't fully cover (see the invariant documented on
    /// [Self::request_withdrawal]). Callable by anyone — like
    /// [Self::batch_harvest], it's a keeper-style convenience so no single
    /// party has to pay the gas for every other investor's fulfillment.
    /// Returns the number of entries fulfilled by this call.
    pub fn process_withdrawal_queue(env: Env) -> u32 {
        let mut head = Self::read_queue_head(&env);
        let tail = Self::read_queue_tail(&env);
        let mut liquidity = Self::read_available_liquidity(&env);
        let mut fulfilled_count: u32 = 0;

        while head < tail {
            let entry: QueuedWithdrawal = match env.storage().persistent().get(&DataKey::QueueEntry(head)) {
                Some(e) => e,
                None => break,
            };

            if liquidity < entry.amount {
                break;
            }

            Self::pay_out(&env, &entry.requester, entry.amount);
            liquidity -= entry.amount;

            env.storage().persistent().remove(&DataKey::QueueEntry(head));

            env.events().publish(
                (symbol_short!("w_fulfil"), entry.requester.clone()),
                (entry.id, entry.shares, entry.amount),
            );

            head += 1;
            fulfilled_count += 1;
        }

        if fulfilled_count > 0 {
            env.storage().instance().set(&DataKey::QueueHead, &head);
            Self::set_available_liquidity(&env, liquidity);
        }

        fulfilled_count
    }

    /// Current withdrawal-queuing threshold (`i128::MAX` if never configured).
    pub fn get_withdrawal_threshold(env: Env) -> i128 {
        Self::read_withdrawal_threshold(&env)
    }

    /// Current liquidity available to fulfill queued withdrawals.
    pub fn get_available_liquidity(env: Env) -> i128 {
        Self::read_available_liquidity(&env)
    }

    /// Number of requests currently waiting in the withdrawal queue.
    pub fn get_queue_length(env: Env) -> u32 {
        let head = Self::read_queue_head(&env);
        let tail = Self::read_queue_tail(&env);
        (tail - head) as u32
    }

    /// Fetch a queued withdrawal by its id, if it hasn't been fulfilled yet.
    pub fn get_queued_withdrawal(env: Env, id: u64) -> Option<QueuedWithdrawal> {
        env.storage().persistent().get(&DataKey::QueueEntry(id))
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

    // ── Withdrawal Queue ─────────────────────────────────────────────────

    #[test]
    fn test_legacy_withdraw_is_unaffected_by_a_configured_threshold() {
        // The EscrowContract-facing `withdraw` must stay unconditional even
        // once a threshold is configured — only `request_withdrawal` is
        // threshold-aware.
        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(1 * USDC));

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(10_000 * USDC));
        client.deposit(&depositor, &(10_000 * USDC));

        let shares = client.get_shares(&depositor);
        let withdrawn = client.withdraw(&depositor, &shares);

        assert_eq!(withdrawn, 10_000 * USDC);
        assert_eq!(client.get_queue_length(), 0);
    }

    #[test]
    fn test_below_threshold_withdrawal_is_immediate() {
        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(5_000 * USDC));

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(3_000 * USDC));
        client.deposit(&depositor, &(3_000 * USDC));

        let shares = client.get_shares(&depositor);
        let paid = client.request_withdrawal(&depositor, &shares);

        assert_eq!(paid, 3_000 * USDC);
        assert_eq!(client.get_shares(&depositor), 0);
        assert_eq!(client.get_queue_length(), 0);
        assert_eq!(token.balance(&depositor), 3_000 * USDC);
    }

    #[test]
    fn test_above_threshold_withdrawal_is_queued_instead_of_executed() {
        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(5_000 * USDC));

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(10_000 * USDC));
        client.deposit(&depositor, &(10_000 * USDC));

        let shares = client.get_shares(&depositor);
        let paid = client.request_withdrawal(&depositor, &shares);

        // Nothing paid out yet, and the shares are already gone (locked in
        // at today's exchange rate) rather than still redeemable elsewhere.
        assert_eq!(paid, 0);
        assert_eq!(client.get_shares(&depositor), 0);
        assert_eq!(token.balance(&depositor), 0);

        assert_eq!(client.get_queue_length(), 1);
        let entry = client.get_queued_withdrawal(&0).unwrap();
        assert_eq!(entry.requester, depositor);
        assert_eq!(entry.shares, shares);
        assert_eq!(entry.amount, 10_000 * USDC);
    }

    #[test]
    fn test_queue_fulfills_in_fifo_order_once_liquidity_covers_the_whole_queue() {
        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(2_000 * USDC));

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        sac.mint(&alice, &(4_000 * USDC));
        sac.mint(&bob, &(3_000 * USDC));
        client.deposit(&alice, &(4_000 * USDC));
        client.deposit(&bob, &(3_000 * USDC));

        // Both exceed the threshold and queue in deposit order.
        let alice_shares = client.get_shares(&alice);
        let bob_shares = client.get_shares(&bob);
        assert_eq!(client.request_withdrawal(&alice, &alice_shares), 0);
        assert_eq!(client.request_withdrawal(&bob, &bob_shares), 0);
        assert_eq!(client.get_queue_length(), 2);

        client.add_liquidity(&admin, &(7_000 * USDC));
        let fulfilled = client.process_withdrawal_queue();

        assert_eq!(fulfilled, 2);
        assert_eq!(client.get_queue_length(), 0);
        assert_eq!(token.balance(&alice), 4_000 * USDC);
        assert_eq!(token.balance(&bob), 3_000 * USDC);
        assert_eq!(client.get_available_liquidity(), 0);
    }

    #[test]
    fn test_partial_liquidity_fulfills_only_the_front_of_the_queue() {
        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(1_000 * USDC));

        let alice = Address::generate(&env);
        let bob = Address::generate(&env);
        sac.mint(&alice, &(8_000 * USDC));
        sac.mint(&bob, &(3_000 * USDC));
        client.deposit(&alice, &(8_000 * USDC));
        client.deposit(&bob, &(3_000 * USDC));

        // Alice queues first (front of the queue) for more than the
        // liquidity that will be available; Bob queues second for less.
        let alice_shares = client.get_shares(&alice);
        let bob_shares = client.get_shares(&bob);
        client.request_withdrawal(&alice, &alice_shares); // id 0, 8,000
        client.request_withdrawal(&bob, &bob_shares); // id 1, 3,000
        assert_eq!(client.get_queue_length(), 2);

        // Enough to cover Bob's smaller request alone, but not Alice's.
        client.add_liquidity(&admin, &(5_000 * USDC));
        let fulfilled = client.process_withdrawal_queue();

        // Strict FIFO: Bob is never paid ahead of Alice just because there's
        // enough liquidity for his smaller request — the queue only ever
        // advances from the front.
        assert_eq!(fulfilled, 0);
        assert_eq!(client.get_queue_length(), 2);
        assert_eq!(token.balance(&alice), 0);
        assert_eq!(token.balance(&bob), 0);
        assert!(client.get_queued_withdrawal(&0).is_some());
        assert!(client.get_queued_withdrawal(&1).is_some());

        // Top up to exactly cover Alice's request (front of the queue).
        client.add_liquidity(&admin, &(3_000 * USDC));
        let fulfilled = client.process_withdrawal_queue();

        // Only Alice is paid — the loop stops there even though Bob's
        // request is still unfulfilled and the queue is now empty of
        // liquidity to reach him yet.
        assert_eq!(fulfilled, 1);
        assert_eq!(client.get_queue_length(), 1);
        assert_eq!(token.balance(&alice), 8_000 * USDC);
        assert_eq!(token.balance(&bob), 0);
        assert!(client.get_queued_withdrawal(&0).is_none());
        assert!(client.get_queued_withdrawal(&1).is_some());

        // Finally enough liquidity reaches Bob.
        client.add_liquidity(&admin, &(3_000 * USDC));
        let fulfilled = client.process_withdrawal_queue();

        assert_eq!(fulfilled, 1);
        assert_eq!(client.get_queue_length(), 0);
        assert_eq!(token.balance(&bob), 3_000 * USDC);
    }

    #[test]
    fn test_set_withdrawal_threshold_requires_admin() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let (_admin, _token, client) = setup(&env, 0);
        let attacker = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_withdrawal_threshold",
                    args: (attacker.clone(), 1_000_i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_withdrawal_threshold(&attacker, &1_000i128);

        assert!(result.is_err());
    }

    #[test]
    fn test_add_liquidity_requires_admin() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let (_admin, _token, client) = setup(&env, 0);
        let attacker = Address::generate(&env);

        let result = client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "add_liquidity",
                    args: (attacker.clone(), 1_000_i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_add_liquidity(&attacker, &1_000i128);

        assert!(result.is_err());
    }

    #[test]
    fn test_deposit_increases_available_liquidity() {
        let env = Env::default();
        let (_admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        assert_eq!(client.get_available_liquidity(), 0);

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(2_000 * USDC));
        client.deposit(&depositor, &(2_000 * USDC));

        assert_eq!(client.get_available_liquidity(), 2_000 * USDC);
    }

    #[test]
    fn test_queued_withdrawal_emits_event() {
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(1_000 * USDC));

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(5_000 * USDC));
        client.deposit(&depositor, &(5_000 * USDC));

        let shares = client.get_shares(&depositor);
        client.request_withdrawal(&depositor, &shares);

        let events = env.events().all();
        let last_event = events.last().unwrap();

        let expected_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
            &env,
            symbol_short!("w_queued").into_val(&env),
            depositor.clone().into_val(&env),
        ];
        assert_eq!(last_event.1, expected_topic);

        let (event_id, event_shares, event_amount): (u64, i128, i128) = last_event.2.into_val(&env);
        assert_eq!(event_id, 0);
        assert_eq!(event_shares, shares);
        assert_eq!(event_amount, 5_000 * USDC);
    }

    #[test]
    fn test_fulfilled_withdrawal_emits_event() {
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let (admin, token, client) = setup(&env, 0);
        let sac = StellarAssetClient::new(&env, &token);

        client.set_withdrawal_threshold(&admin, &(1_000 * USDC));

        let depositor = Address::generate(&env);
        sac.mint(&depositor, &(5_000 * USDC));
        client.deposit(&depositor, &(5_000 * USDC));

        let shares = client.get_shares(&depositor);
        client.request_withdrawal(&depositor, &shares);

        client.add_liquidity(&admin, &(5_000 * USDC));
        client.process_withdrawal_queue();

        let events = env.events().all();
        let last_event = events.last().unwrap();

        let expected_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
            &env,
            symbol_short!("w_fulfil").into_val(&env),
            depositor.clone().into_val(&env),
        ];
        assert_eq!(last_event.1, expected_topic);

        let (event_id, event_shares, event_amount): (u64, i128, i128) = last_event.2.into_val(&env);
        assert_eq!(event_id, 0);
        assert_eq!(event_shares, shares);
        assert_eq!(event_amount, 5_000 * USDC);
    }
}
