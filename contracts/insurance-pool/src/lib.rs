// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

//! Non-custodial protocol insurance fund.
//!
//! Every lending-pool disbursement routes a micro-fee (5 bps, 0.05%) into this
//! contract. The accumulated reserves are a secondary protection layer for
//! lenders: when a loan defaults badly enough that the junior tranche cannot
//! absorb the full loss, the admin claims reserves back out to the lending pool
//! so the tranches are made whole.
//!
//! The contract is non-custodial in the sense that it never pulls funds on its
//! own — the payer always initiates the transfer, and reserves can only ever
//! flow back out to a claim recipient chosen by the admin.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol,
    Vec,
};

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

/// Upper bound on claims per `batch_process_claims` call, so a single batch
/// stays well inside the per-transaction resource budget.
pub const MAX_BATCH_CLAIMS: u32 = 50;

/// Premium skimmed from every disbursement, in basis points (5 = 0.05%).
pub const PREMIUM_FEE_BPS: i128 = 5;
/// Basis point scale (10_000 = 100%).
pub const BPS_SCALE: i128 = 10_000;

/// Computes the 5 bps insurance premium owed on a disbursement `amount`.
///
/// Shared with the lending pool so both sides agree on rounding (floor).
pub fn premium_for(amount: i128) -> i128 {
    if amount <= 0 {
        return 0;
    }
    amount.saturating_mul(PREMIUM_FEE_BPS) / BPS_SCALE
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum InsuranceError {
    /// Contract has already been initialized.
    AlreadyInitialized = 1,
    /// Contract has not been initialized yet.
    NotInitialized = 2,
    /// Amount must be greater than zero.
    InvalidAmount = 3,
    /// Only the admin can perform this action.
    Unauthorized = 4,
    /// Claim exceeds the reserves currently held by the fund.
    InsufficientReserves = 5,
    /// A claim batch must contain at least one claim.
    EmptyBatch = 6,
    /// A claim batch exceeds `MAX_BATCH_CLAIMS`.
    BatchTooLarge = 7,
    /// Batch totals overflowed while computing payouts.
    ArithmeticOverflow = 8,
}

/// One pending default claim submitted to `batch_process_claims`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimRequest {
    /// Where the payout is sent (normally the lending pool).
    pub recipient: Address,
    /// Shortfall the claim asks the fund to cover.
    pub amount: i128,
}

/// Storage keys for the insurance pool contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address allowed to claim reserves.
    Admin,
    /// USDC token contract address.
    Token,
    /// Lending pool contract allowed to record premiums.
    LendingPool,
    /// Reserves currently available to cover tranche losses.
    Reserves,
    /// Lifetime premiums collected.
    TotalCollected,
    /// Lifetime reserves paid out via claims.
    TotalClaimed,
}

#[contract]
pub struct InsurancePoolContract;

#[contractimpl]
impl InsurancePoolContract {
    /// Initialize the fund with its admin, the underlying token, and the
    /// lending pool contract permitted to record disbursement premiums.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        lending_pool: Address,
    ) -> Result<(), InsuranceError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(InsuranceError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage()
            .instance()
            .set(&DataKey::LendingPool, &lending_pool);
        env.storage().instance().set(&DataKey::Reserves, &0i128);
        env.storage()
            .instance()
            .set(&DataKey::TotalCollected, &0i128);
        env.storage().instance().set(&DataKey::TotalClaimed, &0i128);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Point the fund at a new lending pool contract. Admin-only.
    pub fn set_lending_pool(env: Env, lending_pool: Address) -> Result<(), InsuranceError> {
        Self::require_admin(&env)?;

        env.storage()
            .instance()
            .set(&DataKey::LendingPool, &lending_pool);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("set_pool"),), (lending_pool,));

        Ok(())
    }

    /// Book a premium whose tokens were already transferred into this contract.
    ///
    /// Called by the lending pool inside `disburse` right after it moves the
    /// 5 bps fee across. `from` must be the registered lending pool, and the
    /// direct cross-contract call satisfies its `require_auth`.
    pub fn record_premium(env: Env, from: Address, amount: i128) -> Result<(), InsuranceError> {
        if amount <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        from.require_auth();

        let lending_pool: Address = env
            .storage()
            .instance()
            .get(&DataKey::LendingPool)
            .ok_or(InsuranceError::NotInitialized)?;
        if from != lending_pool {
            return Err(InsuranceError::Unauthorized);
        }

        Self::credit(&env, amount);

        env.events()
            .publish((Symbol::new(&env, "premium_recorded"),), (from, amount));

        Ok(())
    }

    /// Top the fund up from an external address (protocol treasury, donations).
    ///
    /// Unlike `record_premium` this pulls the tokens itself, so it is safe for
    /// any funder to call.
    pub fn fund(env: Env, from: Address, amount: i128) -> Result<(), InsuranceError> {
        if amount <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        from.require_auth();

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(InsuranceError::NotInitialized)?;
        token::Client::new(&env, &token_addr).transfer(
            &from,
            &env.current_contract_address(),
            &amount,
        );

        Self::credit(&env, amount);

        env.events()
            .publish((symbol_short!("fund"),), (from, amount));

        Ok(())
    }

    /// Route reserves back out to cover tranche losses. Admin-only.
    ///
    /// `recipient` is normally the lending pool contract, which redistributes
    /// the settlement across the senior/junior tranches during a default.
    pub fn claim(env: Env, recipient: Address, amount: i128) -> Result<(), InsuranceError> {
        if amount <= 0 {
            return Err(InsuranceError::InvalidAmount);
        }
        Self::require_admin(&env)?;

        let reserves = Self::read_i128(&env, &DataKey::Reserves);
        if amount > reserves {
            return Err(InsuranceError::InsufficientReserves);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(InsuranceError::NotInitialized)?;
        token::Client::new(&env, &token_addr).transfer(
            &env.current_contract_address(),
            &recipient,
            &amount,
        );

        let claimed = Self::read_i128(&env, &DataKey::TotalClaimed);
        env.storage()
            .instance()
            .set(&DataKey::Reserves, &(reserves - amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalClaimed, &(claimed + amount));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events()
            .publish((symbol_short!("claim"),), (recipient, amount));

        Ok(())
    }

    /// Settle several default claims in one call against a single reserve
    /// snapshot. Admin-only. Returns the payout for each claim, in input order.
    ///
    /// If reserves cover the whole batch, every claim is paid in full, exactly
    /// as `claim` would pay it. Otherwise each claim is paid pro rata:
    /// `payout = amount * reserves / total_requested`, rounded down. Payouts
    /// never depend on list order, and the rounding dust stays in reserves.
    pub fn batch_process_claims(
        env: Env,
        claims: Vec<ClaimRequest>,
    ) -> Result<Vec<i128>, InsuranceError> {
        if claims.is_empty() {
            return Err(InsuranceError::EmptyBatch);
        }
        if claims.len() > MAX_BATCH_CLAIMS {
            return Err(InsuranceError::BatchTooLarge);
        }
        Self::require_admin(&env)?;

        let mut total_requested: i128 = 0;
        for c in claims.iter() {
            if c.amount <= 0 {
                return Err(InsuranceError::InvalidAmount);
            }
            total_requested = total_requested
                .checked_add(c.amount)
                .ok_or(InsuranceError::ArithmeticOverflow)?;
        }

        let reserves = Self::read_i128(&env, &DataKey::Reserves);
        if reserves <= 0 {
            return Err(InsuranceError::InsufficientReserves);
        }

        let mut payouts: Vec<i128> = Vec::new(&env);
        for c in claims.iter() {
            let payout = if total_requested <= reserves {
                c.amount
            } else {
                c.amount
                    .checked_mul(reserves)
                    .ok_or(InsuranceError::ArithmeticOverflow)?
                    / total_requested
            };
            payouts.push_back(payout);
        }

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(InsuranceError::NotInitialized)?;
        let token_client = token::Client::new(&env, &token_addr);

        let mut total_paid: i128 = 0;
        for (c, payout) in claims.iter().zip(payouts.iter()) {
            if payout > 0 {
                token_client.transfer(&env.current_contract_address(), &c.recipient, &payout);
                total_paid += payout;
            }
            env.events()
                .publish((symbol_short!("claim"),), (c.recipient, payout));
        }

        let claimed = Self::read_i128(&env, &DataKey::TotalClaimed);
        env.storage()
            .instance()
            .set(&DataKey::Reserves, &(reserves - total_paid));
        env.storage()
            .instance()
            .set(&DataKey::TotalClaimed, &(claimed + total_paid));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "batch_claim"),),
            (claims.len(), total_requested, total_paid),
        );

        Ok(payouts)
    }

    /// Reserves currently available to settle claims.
    pub fn get_reserves(env: Env) -> i128 {
        Self::read_i128(&env, &DataKey::Reserves)
    }

    /// Lifetime premiums collected from disbursements and external funding.
    pub fn get_total_collected(env: Env) -> i128 {
        Self::read_i128(&env, &DataKey::TotalCollected)
    }

    /// Lifetime reserves paid out via `claim`.
    pub fn get_total_claimed(env: Env) -> i128 {
        Self::read_i128(&env, &DataKey::TotalClaimed)
    }

    /// The admin permitted to call `claim`.
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    /// The lending pool permitted to call `record_premium`.
    pub fn get_lending_pool(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::LendingPool)
    }

    /// The 5 bps premium owed on a disbursement of `amount`.
    pub fn quote_premium(_env: Env, amount: i128) -> i128 {
        premium_for(amount)
    }

    // ── Internals ────────────────────────────────────────────────────────

    fn require_admin(env: &Env) -> Result<Address, InsuranceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(InsuranceError::NotInitialized)?;
        admin.require_auth();
        Ok(admin)
    }

    fn read_i128(env: &Env, key: &DataKey) -> i128 {
        env.storage().instance().get(key).unwrap_or(0)
    }

    fn credit(env: &Env, amount: i128) {
        let reserves = Self::read_i128(env, &DataKey::Reserves);
        let collected = Self::read_i128(env, &DataKey::TotalCollected);
        env.storage()
            .instance()
            .set(&DataKey::Reserves, &(reserves + amount));
        env.storage()
            .instance()
            .set(&DataKey::TotalCollected, &(collected + amount));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
    use soroban_sdk::{token::StellarAssetClient, IntoVal};

    /// Deploys a token plus an initialized fund, returning
    /// `(admin, lending_pool, token_address, client)`.
    fn setup(env: &Env) -> (Address, Address, Address, InsurancePoolContractClient<'_>) {
        let admin = Address::generate(env);
        let lending_pool = Address::generate(env);

        let token_admin = Address::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();

        let contract_id = env.register(InsurancePoolContract, ());
        let client = InsurancePoolContractClient::new(env, &contract_id);
        client.initialize(&admin, &token_address, &lending_pool);

        (admin, lending_pool, token_address, client)
    }

    #[test]
    fn test_premium_is_five_basis_points() {
        // 100,000 USDC (7 decimals) * 0.05% = 50 USDC.
        assert_eq!(premium_for(100_000_0000000i128), 50_0000000i128);
        assert_eq!(premium_for(0), 0);
        assert_eq!(premium_for(-1), 0);
        // Sub-bps dust floors to zero rather than over-charging.
        assert_eq!(premium_for(1_000i128), 0);
    }

    #[test]
    fn test_record_premium_credits_reserves() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, _token, client) = setup(&env);

        client.record_premium(&lending_pool, &50_0000000i128);
        client.record_premium(&lending_pool, &25_0000000i128);

        assert_eq!(client.get_reserves(), 75_0000000i128);
        assert_eq!(client.get_total_collected(), 75_0000000i128);
        assert_eq!(client.get_total_claimed(), 0);
    }

    #[test]
    fn test_record_premium_rejects_unknown_caller() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, _lending_pool, _token, client) = setup(&env);

        let impostor = Address::generate(&env);
        let err = client.try_record_premium(&impostor, &10_0000000i128);
        assert_eq!(err, Err(Ok(InsuranceError::Unauthorized)));
        assert_eq!(client.get_reserves(), 0);
    }

    #[test]
    fn test_claim_settles_reserves_to_recipient() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);

        // Fund the contract's real token balance so the claim can transfer out.
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&client.address, &100_0000000i128);
        client.record_premium(&lending_pool, &100_0000000i128);

        client.claim(&lending_pool, &60_0000000i128);

        assert_eq!(client.get_reserves(), 40_0000000i128);
        assert_eq!(client.get_total_claimed(), 60_0000000i128);
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&lending_pool), 60_0000000i128);
        assert_eq!(token_client.balance(&client.address), 40_0000000i128);
    }

    #[test]
    fn test_claim_over_reserves_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, _token, client) = setup(&env);

        client.record_premium(&lending_pool, &10_0000000i128);
        let err = client.try_claim(&lending_pool, &11_0000000i128);
        assert_eq!(err, Err(Ok(InsuranceError::InsufficientReserves)));
    }

    #[test]
    fn test_non_admin_cannot_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);

        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&client.address, &100_0000000i128);
        client.record_premium(&lending_pool, &100_0000000i128);

        // Re-scope auth so only the impostor signs — the admin's `require_auth`
        // is then unmet and the invocation traps.
        let impostor = Address::generate(&env);
        let result = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "claim",
                    args: (impostor.clone(), 10_0000000i128).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_claim(&impostor, &10_0000000i128);

        assert!(result.is_err());
        assert_eq!(client.get_reserves(), 100_0000000i128);
    }

    #[test]
    fn test_fund_pulls_tokens_from_external_funder() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, _lending_pool, token_address, client) = setup(&env);

        let funder = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&funder, &500_0000000i128);

        client.fund(&funder, &200_0000000i128);

        assert_eq!(client.get_reserves(), 200_0000000i128);
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&client.address), 200_0000000i128);
        assert_eq!(token_client.balance(&funder), 300_0000000i128);
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, lending_pool, token_address, client) = setup(&env);

        let err = client.try_initialize(&admin, &token_address, &lending_pool);
        assert_eq!(err, Err(Ok(InsuranceError::AlreadyInitialized)));
    }

    #[test]
    fn test_partial_tranche_loss_claim_payouts_severities() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);

        let sac = StellarAssetClient::new(&env, &token_address);
        // Mint 200,000 USDC into the insurance pool reserve
        sac.mint(&client.address, &200_000_0000000i128);
        client.record_premium(&lending_pool, &200_000_0000000i128);

        let expected_repayment = 100_000_0000000i128; // 100,000 USDC tranche

        // 10% partial tranche loss -> Shortfall = 10,000 USDC
        let shortfall_10 = expected_repayment * 10 / 100;
        client.claim(&lending_pool, &shortfall_10);
        assert_eq!(shortfall_10, 10_000_0000000i128);
        assert_ne!(shortfall_10, expected_repayment); // Payout matches shortfall, not full tranche

        // 50% partial tranche loss -> Shortfall = 50,000 USDC
        let shortfall_50 = expected_repayment * 50 / 100;
        client.claim(&lending_pool, &shortfall_50);
        assert_eq!(shortfall_50, 50_000_0000000i128);

        // 90% partial tranche loss -> Shortfall = 90,000 USDC
        let shortfall_90 = expected_repayment * 90 / 100;
        client.claim(&lending_pool, &shortfall_90);
        assert_eq!(shortfall_90, 90_000_0000000i128);

        assert_eq!(client.get_total_claimed(), 150_000_0000000i128);
        assert_eq!(client.get_reserves(), 50_000_0000000i128);
    }

    #[test]
    fn test_claim_payout_capped_by_reserve_balance() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);

        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&client.address, &30_000_0000000i128);
        client.record_premium(&lending_pool, &30_000_0000000i128);

        let tranche_expected = 100_000_0000000i128;
        let partial_shortfall_50 = tranche_expected * 50 / 100; // 50,000 USDC shortfall

        // Claiming 50,000 USDC when reserve is only 30,000 USDC must fail
        let result = client.try_claim(&lending_pool, &partial_shortfall_50);
        assert_eq!(result, Err(Ok(InsuranceError::InsufficientReserves)));
        assert_eq!(client.get_reserves(), 30_000_0000000i128);
    }

    #[test]
    fn test_sequential_claims_deplete_reserves_progressively() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);

        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&client.address, &100_000_0000000i128);
        client.record_premium(&lending_pool, &100_000_0000000i128);

        // Claim 1: Partial loss default #1 (40,000 USDC shortfall)
        client.claim(&lending_pool, &40_000_0000000i128);
        assert_eq!(client.get_reserves(), 60_000_0000000i128);

        // Claim 2: Partial loss default #2 (50,000 USDC shortfall)
        client.claim(&lending_pool, &50_000_0000000i128);
        assert_eq!(client.get_reserves(), 10_000_0000000i128);

        // Claim 3: Partial loss default #3 (20,000 USDC shortfall) -> Exceeds remaining 10,000 reserve
        let err = client.try_claim(&lending_pool, &20_000_0000000i128);
        assert_eq!(err, Err(Ok(InsuranceError::InsufficientReserves)));

        // Claim 3 adjusted to remaining reserve balance (10,000 USDC) -> Exhausts reserve to 0
        client.claim(&lending_pool, &10_000_0000000i128);
        assert_eq!(client.get_reserves(), 0);

        // Claim 4: Any further claim rejected
        let err2 = client.try_claim(&lending_pool, &1_0000000i128);
        assert_eq!(err2, Err(Ok(InsuranceError::InsufficientReserves)));
    }

    /// Mints `amount` into the fund and books it as reserves.
    fn seed_reserves(
        env: &Env,
        client: &InsurancePoolContractClient<'_>,
        lending_pool: &Address,
        token_address: &Address,
        amount: i128,
    ) {
        StellarAssetClient::new(env, token_address).mint(&client.address, &amount);
        client.record_premium(lending_pool, &amount);
    }

    fn claim_request(recipient: &Address, amount: i128) -> ClaimRequest {
        ClaimRequest {
            recipient: recipient.clone(),
            amount,
        }
    }

    #[test]
    fn test_batch_with_sufficient_reserves_pays_in_full() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);
        seed_reserves(
            &env,
            &client,
            &lending_pool,
            &token_address,
            100_000_0000000,
        );

        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let claims = soroban_sdk::vec![
            &env,
            claim_request(&a, 20_000_0000000),
            claim_request(&b, 30_000_0000000),
            claim_request(&c, 10_000_0000000),
        ];

        let payouts = client.batch_process_claims(&claims);

        assert_eq!(
            payouts,
            soroban_sdk::vec![&env, 20_000_0000000i128, 30_000_0000000, 10_000_0000000]
        );
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&a), 20_000_0000000);
        assert_eq!(token_client.balance(&b), 30_000_0000000);
        assert_eq!(token_client.balance(&c), 10_000_0000000);
        assert_eq!(client.get_reserves(), 40_000_0000000);
        assert_eq!(client.get_total_claimed(), 60_000_0000000);
    }

    #[test]
    fn test_batch_exceeding_reserves_pays_pro_rata() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);
        seed_reserves(&env, &client, &lending_pool, &token_address, 60_000_0000000);

        // 120,000 requested against 60,000 reserves: everyone gets 50%.
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        let c = Address::generate(&env);
        let claims = soroban_sdk::vec![
            &env,
            claim_request(&a, 20_000_0000000),
            claim_request(&b, 40_000_0000000),
            claim_request(&c, 60_000_0000000),
        ];

        let payouts = client.batch_process_claims(&claims);

        assert_eq!(
            payouts,
            soroban_sdk::vec![&env, 10_000_0000000i128, 20_000_0000000, 30_000_0000000]
        );
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&a), 10_000_0000000);
        assert_eq!(token_client.balance(&b), 20_000_0000000);
        assert_eq!(token_client.balance(&c), 30_000_0000000);
        assert_eq!(client.get_reserves(), 0);
        assert_eq!(client.get_total_claimed(), 60_000_0000000);
    }

    #[test]
    fn test_batch_pro_rata_is_independent_of_order() {
        let a_amount = 7_0000001i128;
        let b_amount = 13_0000003i128;
        let c_amount = 29_9999999i128;
        let reserves = 17_0000000i128;

        let run = |reverse: bool| -> (i128, i128, i128, i128) {
            let env = Env::default();
            env.mock_all_auths();
            let (_admin, lending_pool, token_address, client) = setup(&env);
            seed_reserves(&env, &client, &lending_pool, &token_address, reserves);

            let a = Address::generate(&env);
            let b = Address::generate(&env);
            let c = Address::generate(&env);
            let mut claims = soroban_sdk::vec![
                &env,
                claim_request(&a, a_amount),
                claim_request(&b, b_amount),
                claim_request(&c, c_amount),
            ];
            if reverse {
                claims = soroban_sdk::vec![
                    &env,
                    claim_request(&c, c_amount),
                    claim_request(&b, b_amount),
                    claim_request(&a, a_amount),
                ];
            }
            client.batch_process_claims(&claims);

            let token_client = token::Client::new(&env, &token_address);
            (
                token_client.balance(&a),
                token_client.balance(&b),
                token_client.balance(&c),
                client.get_reserves(),
            )
        };

        let forward = run(false);
        let reversed = run(true);
        assert_eq!(forward, reversed);

        let total = a_amount + b_amount + c_amount;
        assert_eq!(forward.0, a_amount * reserves / total);
        assert_eq!(forward.1, b_amount * reserves / total);
        assert_eq!(forward.2, c_amount * reserves / total);
        // Nobody is zeroed out, and floor rounding dust stays in reserves.
        assert!(forward.0 > 0 && forward.1 > 0 && forward.2 > 0);
        assert_eq!(forward.0 + forward.1 + forward.2 + forward.3, reserves);
    }

    #[test]
    fn test_single_claim_batch_matches_claim() {
        let amount = 12_345_6789012i128;
        let reserves = 50_000_0000000i128;

        let env_single = Env::default();
        env_single.mock_all_auths();
        let (_a, pool_single, token_single, client_single) = setup(&env_single);
        seed_reserves(
            &env_single,
            &client_single,
            &pool_single,
            &token_single,
            reserves,
        );
        client_single.claim(&pool_single, &amount);

        let env_batch = Env::default();
        env_batch.mock_all_auths();
        let (_b, pool_batch, token_batch, client_batch) = setup(&env_batch);
        seed_reserves(
            &env_batch,
            &client_batch,
            &pool_batch,
            &token_batch,
            reserves,
        );
        let payouts = client_batch.batch_process_claims(&soroban_sdk::vec![
            &env_batch,
            claim_request(&pool_batch, amount),
        ]);

        assert_eq!(payouts, soroban_sdk::vec![&env_batch, amount]);
        assert_eq!(client_batch.get_reserves(), client_single.get_reserves());
        assert_eq!(
            client_batch.get_total_claimed(),
            client_single.get_total_claimed()
        );
        assert_eq!(
            token::Client::new(&env_batch, &token_batch).balance(&pool_batch),
            token::Client::new(&env_single, &token_single).balance(&pool_single),
        );
    }

    #[test]
    fn test_batch_rejects_invalid_input() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);

        let empty: Vec<ClaimRequest> = Vec::new(&env);
        assert_eq!(
            client.try_batch_process_claims(&empty),
            Err(Ok(InsuranceError::EmptyBatch))
        );

        let mut too_many: Vec<ClaimRequest> = Vec::new(&env);
        for _ in 0..=MAX_BATCH_CLAIMS {
            too_many.push_back(claim_request(&lending_pool, 1));
        }
        assert_eq!(
            client.try_batch_process_claims(&too_many),
            Err(Ok(InsuranceError::BatchTooLarge))
        );

        // Reserves are empty, so a valid batch still has nothing to pay from.
        let one = soroban_sdk::vec![&env, claim_request(&lending_pool, 1_0000000)];
        assert_eq!(
            client.try_batch_process_claims(&one),
            Err(Ok(InsuranceError::InsufficientReserves))
        );

        seed_reserves(&env, &client, &lending_pool, &token_address, 10_0000000);
        let bad = soroban_sdk::vec![
            &env,
            claim_request(&lending_pool, 1_0000000),
            claim_request(&lending_pool, 0),
        ];
        assert_eq!(
            client.try_batch_process_claims(&bad),
            Err(Ok(InsuranceError::InvalidAmount))
        );
        assert_eq!(client.get_reserves(), 10_0000000);
    }

    #[test]
    fn test_non_admin_cannot_batch_claims() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, lending_pool, token_address, client) = setup(&env);
        seed_reserves(&env, &client, &lending_pool, &token_address, 100_0000000);

        let impostor = Address::generate(&env);
        let claims = soroban_sdk::vec![&env, claim_request(&impostor, 10_0000000)];
        let result = client
            .mock_auths(&[MockAuth {
                address: &impostor,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "batch_process_claims",
                    args: (claims.clone(),).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_batch_process_claims(&claims);

        assert!(result.is_err());
        assert_eq!(client.get_reserves(), 100_0000000);
    }
}
