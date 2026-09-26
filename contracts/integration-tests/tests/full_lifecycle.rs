//! End-to-end cross-contract tests for the RemitMortgage protocol.
//!
//! These tests deploy the escrow and lending-pool contracts together and drive
//! the complete borrower journey: saving the 30% down-payment in escrow,
//! requesting the 70% mortgage from the pool, milestone disbursement to a
//! whitelisted contractor, and full repayment with interest.
//!
//! Note: when escrow and lending-pool are pulled in as ordinary dependencies
//! (rather than under their own `cfg(test)`), they compile with their
//! production ledger constants. One compound period in the pool is therefore
//! `518_400` ledgers, which is what we advance by before repaying.

use escrow::{EscrowConfig, EscrowContract, EscrowContractClient, EscrowError};
use lending_pool::{
    LendingPoolContract, LendingPoolContractClient, LoanStatus, PoolError, Tranche,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, BytesN, Env, Symbol,
};

/// One USDC expressed in stroops (7 decimals).
const USDC: i128 = 10_000_000;
/// Pool compound period in production ledger terms (~30 days).
const COMPOUND_PERIOD: u32 = 518_400;

struct Protocol<'a> {
    token: Address,
    escrow: EscrowContractClient<'a>,
    pool: LendingPoolContractClient<'a>,
    treasury: Address,
}

/// Deploy a USDC token, an escrow contract (30,000 USDC target), and a lending
/// pool (8% annual, 4% senior) sharing the same admin and token.
fn deploy_protocol<'a>(env: &Env) -> Protocol<'a> {
    // The lifecycle advances the ledger by whole compound periods (518_400
    // ledgers each). Raise the entry TTL limits so persistent state (borrower
    // records, loans, token balances) created here survives those time jumps;
    // the contracts bump instance TTL on every call but not persistent TTL.
    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 3_000_000;
        li.min_temp_entry_ttl = 3_000_000;
        li.max_entry_ttl = 10_000_000;
    });

    let admin = Address::generate(env);
    let treasury = Address::generate(env);

    // USDC test token.
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_id.address();

    // Lending pool: 8% annual interest, 4% fixed senior yield.
    let pool_id = env.register(LendingPoolContract, ());
    let pool = LendingPoolContractClient::new(env, &pool_id);
    pool.initialize(&admin, &token, &800u32, &400u32, &treasury);

    // Escrow: 30,000 USDC savings target, no lockup so release is purely
    // target-gated.
    let escrow_id = env.register(EscrowContract, ());
    let escrow = EscrowContractClient::new(env, &escrow_id);
    escrow.initialize(&EscrowConfig {
        admin: admin.clone(),
        token: token.clone(),
        lending_pool: pool_id.clone(),
        savings_target: 30_000 * USDC,
        max_duration_ledgers: 10_000_000,
        early_withdrawal_penalty_bps: 500,
        min_duration_ledgers: 0,
        penalty_bps_tier1: 500,
        penalty_bps_tier2: 400,
        penalty_bps_tier3: 300,
        penalty_bps_tier4: 200,
        grace_period_ledgers: 120_960,
        default_penalty_bps: 1_000,
        yield_vault: None,
        match_bps: 0,
        match_cap: 0,
    });

    Protocol {
        token,
        escrow,
        pool,
        treasury,
    }
}

#[test]
fn full_borrower_lifecycle_end_to_end() {
    let env = Env::default();
    env.mock_all_auths();

    let p = deploy_protocol(&env);
    let token = TokenClient::new(&env, &p.token);
    let sac = StellarAssetClient::new(&env, &p.token);

    let borrower = Address::generate(&env);
    let investor = Address::generate(&env);
    let contractor = Address::generate(&env);
    let construction_fund = Address::generate(&env);
    let goal = Symbol::new(&env, "home_2026");

    // Borrower needs funds for the escrow down-payment (30k) plus the eventual
    // loan repayment (75.6k). Investor funds the pool with 70k.
    sac.mint(&borrower, &(110_000 * USDC));
    sac.mint(&investor, &(70_000 * USDC));

    // 1. Investor deposits 70,000 USDC into the lending pool.
    p.pool
        .deposit(&investor, &(70_000 * USDC), &Tranche::Senior);
    assert_eq!(p.pool.get_liquidity(), 70_000 * USDC);

    // 2. Borrower saves toward the 30% target in three monthly contributions.
    p.escrow.deposit(&borrower, &goal, &(10_000 * USDC));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + COMPOUND_PERIOD);
    p.escrow.deposit(&borrower, &goal, &(10_000 * USDC));
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + COMPOUND_PERIOD);
    p.escrow.deposit(&borrower, &goal, &(10_000 * USDC));
    assert_eq!(p.escrow.get_balance(&borrower, &goal), 30_000 * USDC);

    // 3. Escrow releases the savings to the construction fund once the target
    //    is met.
    let released = p.escrow.release(&borrower, &goal, &construction_fund);
    assert_eq!(released, 30_000 * USDC);
    assert_eq!(token.balance(&construction_fund), 30_000 * USDC);
    assert_eq!(p.escrow.get_total_pooled(), 0);

    // 4. Borrower requests the 70,000 USDC mortgage and the admin approves it.
    let loan_id = BytesN::from_array(&env, &[7u8; 32]);
    p.pool.request_loan(&borrower, &loan_id, &(70_000 * USDC));
    p.pool.approve_loan(&loan_id);
    assert_eq!(p.pool.get_loan_info(&loan_id).status, LoanStatus::Approved);

    // 5. Whitelist the contractor and disburse in two milestone tranches.
    p.pool.add_contractor(&contractor);
    p.pool.disburse(&loan_id, &contractor, &(30_000 * USDC));
    p.pool.disburse(&loan_id, &contractor, &(40_000 * USDC));
    assert_eq!(token.balance(&contractor), 70_000 * USDC);
    assert_eq!(p.pool.get_loan_info(&loan_id).disbursed, 70_000 * USDC);

    // 6. Advance one compound period; debt grows to 70,000 * 1.08 = 75,600.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + COMPOUND_PERIOD);

    // 7. Borrower repays principal plus 8% interest in full.
    p.pool.repay(&borrower, &loan_id, &(75_600 * USDC));

    // 8. Final assertions: loan repaid, balances reconcile.
    let loan = p.pool.get_loan_info(&loan_id);
    assert_eq!(loan.status, LoanStatus::Repaid);
    assert_eq!(loan.repaid, 75_600 * USDC);
    assert_eq!(loan.outstanding_debt, 0);

    // Contractor keeps the full 70,000. Construction fund holds the 30,000
    // down-payment. Borrower spent 30,000 (savings) + 75,600 (repayment).
    assert_eq!(token.balance(&contractor), 70_000 * USDC);
    assert_eq!(token.balance(&construction_fund), 30_000 * USDC);
    assert_eq!(token.balance(&borrower), 4_400 * USDC);

    // Pool liquidity: 70,000 in, 70,000 out, 75,600 repaid back.
    assert_eq!(p.pool.get_liquidity(), 75_600 * USDC);
    assert_eq!(token.balance(&p.pool.address), 75_600 * USDC);

    // Treasury untouched (no withdrawals occurred).
    assert_eq!(token.balance(&p.treasury), 0);
}

#[test]
fn loan_request_before_escrow_target_met_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let p = deploy_protocol(&env);
    let sac = StellarAssetClient::new(&env, &p.token);

    let borrower = Address::generate(&env);
    let recipient = Address::generate(&env);
    let goal = Symbol::new(&env, "home_2026");

    sac.mint(&borrower, &(30_000 * USDC));

    // Only 10,000 saved against a 30,000 target.
    p.escrow.deposit(&borrower, &goal, &(10_000 * USDC));

    // The escrow-to-pool bridge must reject the loan request until the target
    // is reached.
    let result =
        p.escrow
            .try_release_and_request_loan(&borrower, &goal, &p.pool.address, &recipient);
    assert_eq!(result.unwrap_err(), Ok(EscrowError::TargetNotReached));
}

#[test]
fn disburse_to_non_whitelisted_contractor_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let p = deploy_protocol(&env);
    let sac = StellarAssetClient::new(&env, &p.token);

    let borrower = Address::generate(&env);
    let investor = Address::generate(&env);
    let contractor = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[1u8; 32]);

    sac.mint(&investor, &(70_000 * USDC));
    p.pool
        .deposit(&investor, &(70_000 * USDC), &Tranche::Senior);

    p.pool.request_loan(&borrower, &loan_id, &(70_000 * USDC));
    p.pool.approve_loan(&loan_id);

    // Contractor was never whitelisted by the admin.
    let result = p.pool.try_disburse(&loan_id, &contractor, &(10_000 * USDC));
    assert_eq!(result.unwrap_err(), Ok(PoolError::UnauthorizedContractor));
}

#[test]
fn over_repayment_fails() {
    let env = Env::default();
    env.mock_all_auths();

    let p = deploy_protocol(&env);
    let sac = StellarAssetClient::new(&env, &p.token);

    let borrower = Address::generate(&env);
    let investor = Address::generate(&env);
    let contractor = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[2u8; 32]);

    sac.mint(&investor, &(70_000 * USDC));
    sac.mint(&borrower, &(100_000 * USDC));

    p.pool
        .deposit(&investor, &(70_000 * USDC), &Tranche::Senior);
    p.pool.request_loan(&borrower, &loan_id, &(10_000 * USDC));
    p.pool.approve_loan(&loan_id);
    p.pool.add_contractor(&contractor);
    p.pool.disburse(&loan_id, &contractor, &(10_000 * USDC));

    // Total owed after one period is 10,800. Repaying more must fail.
    env.ledger()
        .set_sequence_number(env.ledger().sequence() + COMPOUND_PERIOD);
    let result = p.pool.try_repay(&borrower, &loan_id, &(50_000 * USDC));
    assert_eq!(result.unwrap_err(), Ok(PoolError::OverPayment));
}

#[test]
fn unauthenticated_escrow_deposit_reverts() {
    let env = Env::default();
    // Do NOT mock_all_auths to test strict require_auth enforcement.

    let p = deploy_protocol(&env);
    let borrower = Address::generate(&env);
    let goal = Symbol::new(&env, "home_2026");

    let result = p.escrow.try_deposit(&borrower, &goal, &(10_000 * USDC));
    assert!(result.is_err());
}

#[test]
fn unauthenticated_escrow_withdraw_reverts() {
    let env = Env::default();
    // Do NOT mock_all_auths to test strict require_auth enforcement.

    let p = deploy_protocol(&env);
    let borrower = Address::generate(&env);
    let goal = Symbol::new(&env, "home_2026");

    let result = p.escrow.try_withdraw(&borrower, &goal);
    assert!(result.is_err());
}

#[test]
fn unauthenticated_lending_pool_request_loan_reverts() {
    let env = Env::default();
    // Do NOT mock_all_auths to test strict require_auth enforcement.

    let p = deploy_protocol(&env);
    let borrower = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[9u8; 32]);

    let result = p.pool.try_request_loan(&borrower, &loan_id, &(70_000 * USDC));
    assert!(result.is_err());
}

#[test]
fn unauthenticated_lending_pool_repay_reverts() {
    let env = Env::default();
    // Do NOT mock_all_auths to test strict require_auth enforcement.

    let p = deploy_protocol(&env);
    let borrower = Address::generate(&env);
    let loan_id = BytesN::from_array(&env, &[9u8; 32]);

    let result = p.pool.try_repay(&borrower, &loan_id, &(10_000 * USDC));
    assert!(result.is_err());
}
