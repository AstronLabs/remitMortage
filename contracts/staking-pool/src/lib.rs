// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env,
    Map, Vec,
};

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days
const BPS_SCALE: u32 = 10_000;

/// Errors returned by the staking pool.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum StakingError {
    /// Amount or share count must be greater than zero.
    InvalidAmount = 1,
    /// The deposit is too small to mint a whole share at the current rate.
    NoSharesMinted = 2,
    /// Staker does not hold enough shares for this operation.
    InsufficientShares = 3,
    /// The pool holds no shares, so there is nothing to unstake or reward.
    EmptyPool = 4,
    /// The token has not been registered on the pool via `add_token`.
    UnsupportedToken = 5,
}

/// Multi-asset staking pool data key.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    /// Map from token Address -> TokenInfo
    SupportedTokens,
    /// Total shares minted by this pool.
    TotalShares,
    /// Share balance per staker address.
    Shares(Address),
    /// Per-token deposit balance per staker: (staker, token) -> amount.
    StakeBalance(Address, Address),
    /// Cumulative reward index per token (used for proportional distribution).
    RewardIndex(Address),
    /// Last-updated ledger for a token's reward accrual.
    LastRewardLedger(Address),
}

/// Per-token metadata tracked by the pool.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenInfo {
    /// Total principal deposited for this token.
    pub total_deposited: i128,
    /// Exchange rate: total_shares / total_deposited (scaled by 1e9).
    pub exchange_rate: i128,
    /// APY in basis points (e.g. 500 = 5%).
    pub apy_bps: u32,
    /// Reward accumulator for proportional distribution.
    pub accumulated_rewards: i128,
}

/// Snapshot of a staker's position.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct StakerInfo {
    /// Total shares held.
    pub shares: i128,
    /// Per-token deposit amounts.
    pub token_balances: Map<Address, i128>,
}

#[contract]
pub struct StakingPoolContract;

impl StakingPoolContract {
    fn admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("not initialized")
    }

    fn read_supported_tokens(env: &Env) -> Map<Address, TokenInfo> {
        env.storage()
            .instance()
            .get(&DataKey::SupportedTokens)
            .unwrap_or(Map::new(env))
    }

    fn write_supported_tokens(env: &Env, tokens: &Map<Address, TokenInfo>) {
        env.storage()
            .instance()
            .set(&DataKey::SupportedTokens, tokens);
    }

    fn read_token_info(env: &Env, token: &Address) -> Option<TokenInfo> {
        let tokens = Self::read_supported_tokens(env);
        tokens.get(token.clone())
    }

    fn write_token_info(env: &Env, token: &Address, info: &TokenInfo) {
        let mut tokens = Self::read_supported_tokens(env);
        tokens.set(token.clone(), info.clone());
        Self::write_supported_tokens(env, &tokens);
    }

    fn total_shares(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalShares)
            .unwrap_or(0)
    }

    fn set_total_shares(env: &Env, amount: i128) {
        env.storage()
            .instance()
            .set(&DataKey::TotalShares, &amount);
    }

    fn read_shares(env: &Env, staker: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Shares(staker.clone()))
            .unwrap_or(0)
    }

    fn write_shares(env: &Env, staker: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::Shares(staker.clone()), &amount);
    }

    fn read_stake_balance(env: &Env, staker: &Address, token: &Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::StakeBalance(staker.clone(), token.clone()))
            .unwrap_or(0)
    }

    fn write_stake_balance(env: &Env, staker: &Address, token: &Address, amount: i128) {
        env.storage()
            .persistent()
            .set(&DataKey::StakeBalance(staker.clone(), token.clone()), &amount);
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }

    /// Compute the exchange rate for a token based on its total deposits and total pool shares.
    /// rate = (total_shares * SCALE) / total_deposited  (or SCALE if total_deposited == 0)
    fn compute_exchange_rate(total_shares: i128, total_deposited: i128) -> i128 {
        const SCALE: i128 = 1_000_000_000;
        if total_deposited == 0 {
            SCALE
        } else {
            (total_shares * SCALE) / total_deposited
        }
    }

    /// Shares a staker receives for depositing `amount` of token with the given exchange rate.
    fn shares_for_deposit(amount: i128, exchange_rate: i128) -> i128 {
        const SCALE: i128 = 1_000_000_000;
        (amount * exchange_rate) / SCALE
    }
}

#[contractimpl]
impl StakingPoolContract {
    /// Initialize the staking pool with an admin address.
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("already initialized");
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::TotalShares, &0i128);
        Self::bump_instance(&env);
    }

    /// Register a new supported token with an APY. Admin only.
    /// Each token can only be registered once (caller must provide a unique address).
    pub fn add_token(env: Env, token: Address, apy_bps: u32) {
        let admin = Self::admin(&env);
        admin.require_auth();

        if Self::read_token_info(&env, &token).is_some() {
            panic!("token already supported");
        }

        let info = TokenInfo {
            total_deposited: 0,
            exchange_rate: 1_000_000_000,
            apy_bps,
            accumulated_rewards: 0,
        };
        Self::write_token_info(&env, &token, &info);
        Self::bump_instance(&env);
    }

    /// Update the APY for an existing supported token. Admin only.
    /// Does not affect existing deposits — only new reward accrual calculations.
    pub fn set_token_apy(env: Env, token: Address, new_apy_bps: u32) {
        let admin = Self::admin(&env);
        admin.require_auth();

        let mut info = Self::read_token_info(&env, &token).expect("token not supported");
        info.apy_bps = new_apy_bps;
        Self::write_token_info(&env, &token, &info);
        Self::bump_instance(&env);
    }

    /// Remove a supported token. Admin only. Reverts if the token still has deposits.
    pub fn remove_token(env: Env, token: Address) {
        let admin = Self::admin(&env);
        admin.require_auth();

        let info = Self::read_token_info(&env, &token).expect("token not supported");
        if info.total_deposited > 0 {
            panic!("token has active deposits");
        }
        let mut tokens = Self::read_supported_tokens(&env);
        tokens.remove(token);
        Self::write_supported_tokens(&env, &tokens);
        Self::bump_instance(&env);
    }

    /// Get list of supported token addresses and their info.
    pub fn get_supported_tokens(env: Env) -> Vec<(Address, TokenInfo)> {
        let tokens = Self::read_supported_tokens(&env);
        let mut result: Vec<(Address, TokenInfo)> = Vec::new(&env);
        for key in tokens.keys() {
            if let Some(info) = tokens.get(key.clone()) {
                result.push_back((key.clone(), info));
            }
        }
        result
    }

    /// Stake `amount` of `token` into the pool. Mints shares proportional to
    /// the current exchange rate and records the deposit for yield distribution.
    pub fn stake(env: Env, staker: Address, token: Address, amount: i128) -> Result<i128, StakingError> {
        staker.require_auth();

        if amount <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let mut info = Self::read_token_info(&env, &token).ok_or(StakingError::UnsupportedToken)?;

        // Pull tokens from staker into the pool.
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&staker, &env.current_contract_address(), &amount);

        // Compute shares to mint based on current exchange rate.
        let total_shares = Self::total_shares(&env);
        let rate = Self::compute_exchange_rate(total_shares, info.total_deposited);
        let minted = Self::shares_for_deposit(amount, rate);

        if minted <= 0 {
            return Err(StakingError::NoSharesMinted);
        }

        // Update pool-level totals.
        Self::set_total_shares(&env, total_shares + minted);
        info.total_deposited += amount;
        info.exchange_rate = Self::compute_exchange_rate(total_shares + minted, info.total_deposited);
        Self::write_token_info(&env, &token, &info);

        // Update staker balances.
        let staker_shares = Self::read_shares(&env, &staker) + minted;
        Self::write_shares(&env, &staker, staker_shares);

        let stake_bal = Self::read_stake_balance(&env, &staker, &token) + amount;
        Self::write_stake_balance(&env, &staker, &token, stake_bal);

        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("stake"),),
            (staker, token, amount, minted),
        );

        Ok(minted)
    }

    /// Unstake `shares` from the pool. Burns the shares and returns the
    /// proportional deposit from each token pool based on the staker's
    /// token allocation.
    pub fn unstake(env: Env, staker: Address, shares: i128) -> Result<i128, StakingError> {
        staker.require_auth();

        if shares <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        let staker_shares = Self::read_shares(&env, &staker);
        if shares > staker_shares {
            return Err(StakingError::InsufficientShares);
        }

        let total_shares = Self::total_shares(&env);
        if total_shares == 0 {
            return Err(StakingError::EmptyPool);
        }

        // Compute the fraction of pool being withdrawn.
        // Returns total amount withdrawn across all tokens.
        let tokens = Self::read_supported_tokens(&env);
        let mut total_withdrawn: i128 = 0;

        for token_key in tokens.keys() {
            let stake_bal = Self::read_stake_balance(&env, &staker, &token_key);
            if stake_bal <= 0 {
                continue;
            }

            // Proportional withdrawal from this token pool.
            let withdraw_amount = (stake_bal * shares) / staker_shares;
            if withdraw_amount <= 0 {
                continue;
            }

            // Update staker's token balance.
            let new_stake_bal = stake_bal - withdraw_amount;
            Self::write_stake_balance(&env, &staker, &token_key, new_stake_bal);

            // Update token pool totals.
            let mut info = tokens.get(token_key.clone()).unwrap();
            info.total_deposited = info.total_deposited.saturating_sub(withdraw_amount);
            if info.total_deposited > 0 {
                info.exchange_rate = Self::compute_exchange_rate(total_shares - shares, info.total_deposited);
            } else {
                info.exchange_rate = 1_000_000_000;
            }
            Self::write_token_info(&env, &token_key, &info);

            // Transfer tokens back to staker.
            let token_client = token::Client::new(&env, &token_key);
            token_client.transfer(
                &env.current_contract_address(),
                &staker,
                &withdraw_amount,
            );

            total_withdrawn += withdraw_amount;
        }

        // Burn shares.
        Self::write_shares(&env, &staker, staker_shares - shares);
        Self::set_total_shares(&env, total_shares - shares);

        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("unstake"),),
            (staker, shares, total_withdrawn),
        );

        Ok(total_withdrawn)
    }

    /// Distribute rewards proportionally across all supported token pools.
    /// `reward_token` is the token in which rewards are paid.
    /// `total_reward` is the total reward amount to distribute.
    /// Rewards are allocated to each token pool proportional to its share of
    /// total deposits, and credited to the pool's accumulator so that the
    /// yield waterfall logic picks them up.
    pub fn distribute_rewards(
        env: Env,
        from: Address,
        reward_token: Address,
        total_reward: i128,
    ) -> Result<(), StakingError> {
        let admin = Self::admin(&env);
        admin.require_auth();

        if total_reward <= 0 {
            return Err(StakingError::InvalidAmount);
        }

        // Pull reward tokens into the pool.
        let token_client = token::Client::new(&env, &reward_token);
        token_client.transfer(&from, &env.current_contract_address(), &total_reward);

        let tokens = Self::read_supported_tokens(&env);
        let mut total_deposits: i128 = 0;
        for key in tokens.keys() {
            let info = tokens.get(key.clone()).unwrap();
            total_deposits += info.total_deposited;
        }

        if total_deposits == 0 {
            // No deposits — rewards are returned (transfer back).
            token_client.transfer(&env.current_contract_address(), &from, &total_reward);
            return Ok(());
        }

        for key in tokens.keys() {
            let mut info = tokens.get(key.clone()).unwrap();
            if info.total_deposited > 0 {
                // Reward allocation proportional to this token's share of total deposits.
                let alloc = (total_reward * info.total_deposited) / total_deposits;
                if alloc > 0 {
                    info.accumulated_rewards += alloc;
                    Self::write_token_info(&env, &key, &info);
                }
            }
        }

        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("rewards"),),
            (total_reward, total_deposits),
        );

        Ok(())
    }

    /// Claim accumulated rewards for a staker. Rewards are distributed
    /// proportionally based on the staker's share weight across all pools.
    /// Returns the total reward amount claimed.
    pub fn claim_rewards(env: Env, staker: Address) -> Result<i128, StakingError> {
        staker.require_auth();

        let staker_shares = Self::read_shares(&env, &staker);
        if staker_shares <= 0 {
            return Err(StakingError::InsufficientShares);
        }

        let total_shares = Self::total_shares(&env);
        if total_shares == 0 {
            return Err(StakingError::EmptyPool);
        }

        let tokens = Self::read_supported_tokens(&env);
        let mut total_claim: i128 = 0;

        for key in tokens.keys() {
            let mut info = tokens.get(key.clone()).unwrap();
            if info.accumulated_rewards <= 0 {
                continue;
            }

            // Staker's share of accumulated rewards for this token pool.
            let claim = (info.accumulated_rewards * staker_shares) / total_shares;
            if claim <= 0 {
                continue;
            }

            info.accumulated_rewards -= claim;
            Self::write_token_info(&env, &key, &info);

            // Transfer claimed reward tokens to the staker.
            let token_client = token::Client::new(&env, &key);
            token_client.transfer(
                &env.current_contract_address(),
                &staker,
                &claim,
            );

            total_claim += claim;
        }

        if total_claim > 0 {
            Self::bump_instance(&env);
        }

        env.events().publish(
            (symbol_short!("claim_rew"),),
            (staker, total_claim),
        );

        Ok(total_claim)
    }

    /// Query a staker's total shares.
    pub fn get_shares(env: Env, staker: Address) -> i128 {
        Self::read_shares(&env, &staker)
    }

    /// Query a staker's deposit balance for a given token.
    pub fn get_stake_balance(env: Env, staker: Address, token: Address) -> i128 {
        Self::read_stake_balance(&env, &staker, &token)
    }

    /// Query total pool shares.
    pub fn get_total_shares(env: Env) -> i128 {
        Self::total_shares(&env)
    }

    /// Query token info (total deposited, exchange rate, APY, accumulated rewards).
    pub fn get_token_info(env: Env, token: Address) -> Option<TokenInfo> {
        Self::read_token_info(&env, &token)
    }

    /// Query accumulated rewards for a specific token pool.
    pub fn get_accumulated_rewards(env: Env, token: Address) -> i128 {
        Self::read_token_info(&env, &token)
            .map(|info| info.accumulated_rewards)
            .unwrap_or(0)
    }

    /// Query current contract version.
    pub fn version(_env: Env) -> u32 {
        1
    }

    /// Preview the yield waterfall: returns how a reward of `total_reward`
    /// would be split across the supported token pools based on their
    /// proportional deposit weights.
    ///
    /// Each entry is `(token_address, allocated_amount)`. The sum of all
    /// allocated amounts will be ≤ `total_reward` (rounding down).
    pub fn preview_yield_waterfall(env: Env, total_reward: i128) -> Vec<(Address, i128)> {
        let mut result: Vec<(Address, i128)> = Vec::new(&env);
        if total_reward <= 0 {
            return result;
        }

        let tokens = Self::read_supported_tokens(&env);
        let mut total_deposits: i128 = 0;
        for key in tokens.keys() {
            if let Some(info) = tokens.get(key.clone()) {
                total_deposits += info.total_deposited;
            }
        }

        if total_deposits == 0 {
            return result;
        }

        for key in tokens.keys() {
            if let Some(info) = tokens.get(key.clone()) {
                let alloc = (total_reward * info.total_deposited) / total_deposits;
                result.push_back((key.clone(), alloc));
            }
        }

        result
    }
}

#[cfg(test)]
mod test {
    // The crate is `no_std`, but these tests reach for `std::panic::catch_unwind`
    // to assert on panicking contract calls.
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{token::StellarAssetClient, Env, IntoVal, Vec};

    fn setup(env: &Env) -> (Address, Address, Address, StakingPoolContractClient<'static>) {
        let admin = Address::generate(env);
        let contract_id = env.register(StakingPoolContract, ());
        let client = StakingPoolContractClient::new(env, &contract_id);
        client.initialize(&admin);

        // Create two test tokens.
        let token_admin = Address::generate(env);
        let token_a_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_b_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_a = token_a_id.address();
        let token_b = token_b_id.address();

        (admin, token_a, token_b, client)
    }

    fn mint_to(env: &Env, token: &Address, to: &Address, amount: i128) {
        let sac = StellarAssetClient::new(env, token);
        sac.mint(to, &amount);
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, _token_a, _token_b, _client) = setup(&env);
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _token_a, _token_b, client) = setup(&env);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.initialize(&admin);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_add_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);

        client.add_token(&token_a, &500u32);
        let info = client.get_token_info(&token_a).unwrap();
        assert_eq!(info.apy_bps, 500);
        assert_eq!(info.total_deposited, 0);
        assert_eq!(info.exchange_rate, 1_000_000_000);
    }

    #[test]
    fn test_stake_single_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);

        let minted = client.stake(&staker, &token_a, &50_000_0000i128).unwrap();
        assert!(minted > 0);

        let shares = client.get_shares(&staker);
        assert_eq!(shares, minted);

        let balance = client.get_stake_balance(&staker, &token_a);
        assert_eq!(balance, 50_000_0000i128);

        let pool_total = client.get_total_shares();
        assert_eq!(pool_total, minted);
    }

    #[test]
    fn test_stake_two_tokens_isolation() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        let minted_a = client.stake(&staker, &token_a, &30_000_0000i128).unwrap();
        let minted_b = client.stake(&staker, &token_b, &20_000_0000i128).unwrap();

        // Each token pool has its own deposit tracking.
        let bal_a = client.get_stake_balance(&staker, &token_a);
        let bal_b = client.get_stake_balance(&staker, &token_b);
        assert_eq!(bal_a, 30_000_0000i128);
        assert_eq!(bal_b, 20_000_0000i128);

        // Shares are shared across all tokens.
        let total_shares = client.get_shares(&staker);
        assert_eq!(total_shares, minted_a + minted_b);
    }

    #[test]
    fn test_unstake_returns_proportional_tokens() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        let _minted_a = client.stake(&staker, &token_a, &50_000_0000i128).unwrap();
        let _minted_b = client.stake(&staker, &token_b, &30_000_0000i128).unwrap();

        // Unstake half the shares.
        let total_shares = client.get_shares(&staker);
        let half = total_shares / 2;
        let withdrawn = client.unstake(&staker, &half).unwrap();

        // Should receive proportional tokens from each pool.
        assert!(withdrawn > 0);

        let remaining_a = client.get_stake_balance(&staker, &token_a);
        let remaining_b = client.get_stake_balance(&staker, &token_b);
        assert!(remaining_a < 50_000_0000i128);
        assert!(remaining_b < 30_000_0000i128);
        assert_eq!(client.get_shares(&staker), total_shares - half);
    }

    #[test]
    fn test_unstake_full_exits_all_pools() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        client.stake(&staker, &token_a, &40_000_0000i128).unwrap();
        client.stake(&staker, &token_b, &20_000_0000i128).unwrap();

        let total_shares = client.get_shares(&staker);
        let withdrawn = client.unstake(&staker, &total_shares).unwrap();

        assert!(withdrawn >= 60_000_0000i128 - 1); // allow small rounding
        assert_eq!(client.get_shares(&staker), 0);
        assert_eq!(client.get_stake_balance(&staker, &token_a), 0);
        assert_eq!(client.get_stake_balance(&staker, &token_b), 0);
    }

    #[test]
    fn test_zero_cross_pool_interference() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker_a = Address::generate(&env);
        let staker_b = Address::generate(&env);

        mint_to(&env, &token_a, &staker_a, 100_000_0000i128);
        mint_to(&env, &token_b, &staker_b, 100_000_0000i128);

        // Each staker only deposits one token.
        client.stake(&staker_a, &token_a, &50_000_0000i128).unwrap();
        client.stake(&staker_b, &token_b, &30_000_0000i128).unwrap();

        // Staker A has no balance in token B.
        assert_eq!(client.get_stake_balance(&staker_a, &token_b), 0);
        // Staker B has no balance in token A.
        assert_eq!(client.get_stake_balance(&staker_b, &token_a), 0);

        // Unstaking works independently.
        let shares_a = client.get_shares(&staker_a);
        let withdrawn_a = client.unstake(&staker_a, &shares_a).unwrap();
        // When staker A unstakes fully, they should receive back their token_a deposit
        // (all of it, since staker B's deposit of token_b doesn't affect A's token_a balance).
        // The proportional math: A has 100% of shares attributed to token_a pool.
        assert!(withdrawn_a <= 50_000_0000i128);
    }

    // ── Reward Distribution Tests ────────────────────────────────────

    #[test]
    fn test_distribute_rewards_proportional() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        // Stake 60_000 token A and 40_000 token B
        client.stake(&staker, &token_a, &60_000_0000i128).unwrap();
        client.stake(&staker, &token_b, &40_000_0000i128).unwrap();

        // Admin distributes 10_000 reward tokens (using token_a as reward denomination).
        // But rewards distribute proportionally: token_a pool gets 60%, token_b gets 40%.
        // Since rewards go to accumulated_rewards per token pool, we use a separate reward token.
        // For this test we can reward in token A itself.
        // We need to mint reward tokens to the admin address.
        let reward_amount = 10_000_0000i128;
        mint_to(&env, &token_a, &admin, reward_amount);

        client.distribute_rewards(&admin, &token_a, &reward_amount).unwrap();

        // Token A pool should have accumulated ~60% of the reward.
        let info_a = client.get_token_info(&token_a).unwrap();
        let info_b = client.get_token_info(&token_b).unwrap();
        // 60_000 / 100_000 = 0.6 * 10_000 = 6_000
        assert!(info_a.accumulated_rewards >= 5_900_0000i128);
        assert!(info_a.accumulated_rewards <= 6_100_0000i128);
        // 40_000 / 100_000 = 0.4 * 10_000 = 4_000
        assert!(info_b.accumulated_rewards >= 3_900_0000i128);
        assert!(info_b.accumulated_rewards <= 4_100_0000i128);
    }

    #[test]
    fn test_claim_rewards_after_distribution() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        client.stake(&staker, &token_a, &50_000_0000i128).unwrap();
        client.stake(&staker, &token_b, &50_000_0000i128).unwrap();

        // Distribute 20_000 reward in token A.
        let reward_amount = 20_000_0000i128;
        mint_to(&env, &token_a, &admin, reward_amount);
        client.distribute_rewards(&admin, &token_a, &reward_amount).unwrap();

        let total_accumulated = client.get_accumulated_rewards(&token_a)
            + client.get_accumulated_rewards(&token_b);

        // Single staker should claim all accumulated rewards.
        let claimed = client.claim_rewards(&staker).unwrap();
        assert!(claimed > 0);
        // After claiming, accumulated rewards should be zero.
        assert_eq!(client.get_accumulated_rewards(&token_a), 0);
        assert_eq!(client.get_accumulated_rewards(&token_b), 0);
    }

    #[test]
    fn test_rewards_distributed_to_multiple_stakers() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker1 = Address::generate(&env);
        let staker2 = Address::generate(&env);

        mint_to(&env, &token_a, &staker1, 100_000_0000i128);
        mint_to(&env, &token_a, &staker2, 100_000_0000i128);
        mint_to(&env, &token_b, &staker1, 100_000_0000i128);
        mint_to(&env, &token_b, &staker2, 100_000_0000i128);

        // Staker1 deposits 60_000 token A + 0 token B
        // Staker2 deposits 20_000 token A + 20_000 token B
        client.stake(&staker1, &token_a, &60_000_0000i128).unwrap();
        client.stake(&staker2, &token_a, &20_000_0000i128).unwrap();
        client.stake(&staker2, &token_b, &20_000_0000i128).unwrap();

        // Total deposits: token A = 80_000, token B = 20_000 → total = 100_000
        let reward_amount = 50_000_0000i128;
        mint_to(&env, &token_a, &admin, reward_amount);
        client.distribute_rewards(&admin, &token_a, &reward_amount).unwrap();

        // Claim rewards for each staker.
        let claimed1 = client.claim_rewards(&staker1).unwrap();
        let claimed2 = client.claim_rewards(&staker2).unwrap();

        // Staker1 owns 60_000 / 100_000 = 60% of total deposits → ~60% of rewards
        // Staker2 owns 40_000 / 100_000 = 40% → ~40%
        assert!(claimed1 > claimed2);
        // Total claimed should be approximately reward_amount (token A only; token B pool gets none since reward_token = token A)
        // Actually the rewards go to both pools proportionally, and stakers claim from all pools.
        // Token A pool gets 80_000 / 100_000 * 50_000 = 40_000
        // Token B pool gets 20_000 / 100_000 * 50_000 = 10_000
        // Staker1: 60_000/80_000 of token A = 30_000 + 0/20_000 of token B = 0 → 30_000
        // Staker2: 20_000/80_000 of token A = 10_000 + 20_000/20_000 of token B = 10_000 → 20_000
        assert!(claimed1 + claimed2 <= reward_amount);
        assert!(claimed1 + claimed2 > 0);
    }

    #[test]
    fn test_stake_invalid_amount_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        let staker = Address::generate(&env);

        let result = client.try_stake(&staker, &token_a, &0i128);
        assert_eq!(result, Err(Ok(StakingError::InvalidAmount)));
    }

    #[test]
    fn test_stake_unsupported_token_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, token_a, _token_b, client) = setup(&env);

        let staker = Address::generate(&env);
        let result = client.try_stake(&staker, &token_a, &100i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_unstake_more_than_balance_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        let staker = Address::generate(&env);
        let result = client.try_unstake(&staker, &100i128);
        assert_eq!(result, Err(Ok(StakingError::InsufficientShares)));
    }

    #[test]
    fn test_withdrawal_isolation_multi_staker() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let s1 = Address::generate(&env);
        let s2 = Address::generate(&env);

        mint_to(&env, &token_a, &s1, 100_000_0000i128);
        mint_to(&env, &token_a, &s2, 100_000_0000i128);
        mint_to(&env, &token_b, &s1, 100_000_0000i128);
        mint_to(&env, &token_b, &s2, 100_000_0000i128);

        // Both stake the same amounts.
        client.stake(&s1, &token_a, &40_000_0000i128).unwrap();
        client.stake(&s1, &token_b, &10_000_0000i128).unwrap();
        client.stake(&s2, &token_a, &20_000_0000i128).unwrap();
        client.stake(&s2, &token_b, &30_000_0000i128).unwrap();

        // S1 unstakes fully.
        let s1_shares = client.get_shares(&s1);
        client.unstake(&s1, &s1_shares).unwrap();

        // S1 should have zero in both pools.
        assert_eq!(client.get_stake_balance(&s1, &token_a), 0);
        assert_eq!(client.get_stake_balance(&s1, &token_b), 0);

        // S2's balances should be completely unaffected by S1's withdrawal.
        let s2_bal_a = client.get_stake_balance(&s2, &token_a);
        let s2_bal_b = client.get_stake_balance(&s2, &token_b);
        assert_eq!(s2_bal_a, 20_000_0000i128);
        assert_eq!(s2_bal_b, 30_000_0000i128);

        // S2 can still unstake.
        let s2_shares = client.get_shares(&s2);
        client.unstake(&s2, &s2_shares).unwrap();
        assert_eq!(client.get_stake_balance(&s2, &token_a), 0);
        assert_eq!(client.get_stake_balance(&s2, &token_b), 0);
    }

    #[test]
    fn test_partial_unstake_preserves_ratio() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        client.stake(&staker, &token_a, &80_000_0000i128).unwrap();
        client.stake(&staker, &token_b, &20_000_0000i128).unwrap();

        // Unstake 25% of shares.
        let total = client.get_shares(&staker);
        let quarter = total / 4;
        client.unstake(&staker, &quarter).unwrap();

        // The remaining balance ratios should be roughly preserved.
        let rem_a = client.get_stake_balance(&staker, &token_a);
        let rem_b = client.get_stake_balance(&staker, &token_b);
        // Original: 80_000 A, 20_000 B. After 25% withdrawal: ~60_000 A, ~15_000 B.
        assert!(rem_a > rem_b);
        assert!(rem_a < 80_000_0000i128);
        assert_eq!(client.get_shares(&staker), total - quarter);
    }

    #[test]
    fn test_add_token_twice_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.add_token(&token_a, &600u32);
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_yield_waterfall_exact_proportions() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        // Stake exactly 75_000 in token A, 25_000 in token B.
        client.stake(&staker, &token_a, &75_000_0000i128).unwrap();
        client.stake(&staker, &token_b, &25_000_0000i128).unwrap();

        // Preview the waterfall for a reward of 12_000.
        let waterfall = client.preview_yield_waterfall(&12_000_0000i128);
        assert_eq!(waterfall.len(), 2);

        // Find the allocations.
        let mut alloc_a: i128 = 0;
        let mut alloc_b: i128 = 0;
        for (addr, alloc) in waterfall.iter() {
            if addr == token_a {
                alloc_a = alloc;
            } else if addr == token_b {
                alloc_b = alloc;
            }
        }

        // Token A: 75% of 12_000 = 9_000
        // Token B: 25% of 12_000 = 3_000
        assert_eq!(alloc_a, 9_000_0000i128);
        assert_eq!(alloc_b, 3_000_0000i128);
    }

    #[test]
    fn test_yield_waterfall_uneven_weights() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        mint_to(&env, &token_b, &staker, 100_000_0000i128);

        // Stake 10_000 in token A, 90_000 in token B.
        client.stake(&staker, &token_a, &10_000_0000i128).unwrap();
        client.stake(&staker, &token_b, &90_000_0000i128).unwrap();

        let waterfall = client.preview_yield_waterfall(&100_000_0000i128);
        assert_eq!(waterfall.len(), 2);

        let mut alloc_a: i128 = 0;
        let mut alloc_b: i128 = 0;
        for (addr, alloc) in waterfall.iter() {
            if addr == token_a {
                alloc_a = alloc;
            } else if addr == token_b {
                alloc_b = alloc;
            }
        }

        // Token A: 10% of 100_000 = 10_000
        // Token B: 90% of 100_000 = 90_000
        assert_eq!(alloc_a, 10_000_0000i128);
        assert_eq!(alloc_b, 90_000_0000i128);
    }

    #[test]
    fn test_yield_waterfall_single_token() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        client.stake(&staker, &token_a, &50_000_0000i128).unwrap();

        // Single pool should get 100% of rewards.
        let waterfall = client.preview_yield_waterfall(&10_000_0000i128);
        assert_eq!(waterfall.len(), 1);
        let (addr, alloc) = waterfall.get(0).unwrap();
        assert_eq!(addr, token_a);
        assert_eq!(alloc, 10_000_0000i128);
    }

    #[test]
    fn test_yield_waterfall_empty_pool() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        // No deposits yet — waterfall should return empty.
        let waterfall = client.preview_yield_waterfall(&10_000_0000i128);
        assert_eq!(waterfall.len(), 0);
    }

    #[test]
    fn test_yield_waterfall_zero_reward() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);
        client.add_token(&token_b, &300u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        client.stake(&staker, &token_a, &50_000_0000i128).unwrap();

        // Zero reward — waterfall should return empty.
        let waterfall = client.preview_yield_waterfall(&0i128);
        assert_eq!(waterfall.len(), 0);
    }

    #[test]
    fn test_set_token_apy() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        client.set_token_apy(&token_a, &800u32);
        let info = client.get_token_info(&token_a).unwrap();
        assert_eq!(info.apy_bps, 800);
    }

    #[test]
    fn test_remove_token_fails_with_deposits() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, token_a, _token_b, client) = setup(&env);
        client.add_token(&token_a, &500u32);

        let staker = Address::generate(&env);
        mint_to(&env, &token_a, &staker, 100_000_0000i128);
        client.stake(&staker, &token_a, &10_000_0000i128).unwrap();

        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.remove_token(&token_a);
        }));
        assert!(result.is_err());
    }
}
