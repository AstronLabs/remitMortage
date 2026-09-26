//! Integration test for Escrow Contract + Yield Vault Integration.
//!
//! Tests borrower depositing into Escrow configured with a Yield Vault,
//! simulating a 6-month period where yield accrues, and verifying that
//! upon withdrawal/release, the total returned amount includes the accrued yield.

use escrow::{EscrowConfig, EscrowContract, EscrowContractClient};
use yield_vault::{YieldVaultContract, YieldVaultContractClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol,
};

/// 1 USDC in stroops (7 decimals).
const USDC: i128 = 10_000_000;

/// 6 months in ledgers (~518,400 ledgers).
const SIX_MONTHS_LEDGERS: u32 = 518_400;

struct TestSetup<'a> {
    env: Env,
    admin: Address,
    token: Address,
    token_client: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
    escrow: EscrowContractClient<'a>,
    vault: YieldVaultContractClient<'a>,
}

fn setup_protocol<'a>(env: &'a Env, apy_bps: u32) -> TestSetup<'a> {
    env.mock_all_auths();

    env.ledger().with_mut(|li| {
        li.min_persistent_entry_ttl = 3_000_000;
        li.min_temp_entry_ttl = 3_000_000;
        li.max_entry_ttl = 10_000_000;
    });

    let admin = Address::generate(env);
    let token_admin = Address::generate(env);
    let token_id = env.register_stellar_asset_contract_v2(token_admin);
    let token = token_id.address();

    let token_client = TokenClient::new(env, &token);
    let sac = StellarAssetClient::new(env, &token);

    // Deploy Yield Vault (configured with apy_bps, e.g., 500 = 5% APY)
    let vault_id = env.register(YieldVaultContract, ());
    let vault = YieldVaultContractClient::new(env, &vault_id);
    vault.initialize(&admin, &token, &apy_bps);

    // Deploy Escrow Contract configured with yield_vault
    let lending_pool = Address::generate(env);
    let escrow_id = env.register(EscrowContract, ());
    let escrow = EscrowContractClient::new(env, &escrow_id);

    let config = EscrowConfig {
        admin: admin.clone(),
        token: token.clone(),
        lending_pool,
        savings_target: 30_000 * USDC,
        max_duration_ledgers: 10_000_000,
        early_withdrawal_penalty_bps: 0, // Set to 0 to clearly verify yield addition
        min_duration_ledgers: 0,
        penalty_bps_tier1: 0,
        penalty_bps_tier2: 0,
        penalty_bps_tier3: 0,
        penalty_bps_tier4: 0,
        grace_period_ledgers: 120_960,
        default_penalty_bps: 1_000,
        yield_vault: Some(vault_id.clone()),
        match_bps: 0,
        match_cap: 0,
    };
    escrow.initialize(&config);

    TestSetup {
        env: env.clone(),
        admin,
        token,
        token_client,
        sac,
        escrow,
        vault,
    }
}

#[test]
fn test_escrow_deposit_and_withdrawal_with_yield_vault() {
    let env = Env::default();
    let setup = setup_protocol(&env, 500); // 5% APY

    let borrower = Address::generate(&env);
    let deposit_amount = 10_000 * USDC;

    // Mint USDC to borrower
    setup.sac.mint(&borrower, &deposit_amount);
    assert_eq!(setup.token_client.balance(&borrower), deposit_amount);

    // Borrower deposits into Escrow (which routes to Yield Vault)
    let goal_id = Symbol::new(&env, "house_downpayment");
    setup.escrow.deposit(&borrower, &deposit_amount, &goal_id);

    // Check borrower token balance is 0 and Vault has the deposited USDC
    assert_eq!(setup.token_client.balance(&borrower), 0);
    assert_eq!(setup.token_client.balance(&setup.vault.address), deposit_amount);

    // Verify vault shares were minted
    let vault_shares = setup.vault.get_shares(&setup.escrow.address);
    assert_eq!(vault_shares, deposit_amount);

    // Advance ledger by 6 months (~518,400 ledgers)
    env.ledger().with_mut(|li| {
        li.sequence_number += SIX_MONTHS_LEDGERS;
    });

    // Calculate expected 6-month yield (5% / 2 = 2.5% yield = ~250 USDC)
    let total_assets_after = setup.vault.get_total_assets();
    assert!(total_assets_after > deposit_amount, "Yield should have accrued in vault");

    let borrower_balance_before = setup.token_client.balance(&borrower);

    // Borrower withdraws early from Escrow (with 0% penalty tier configured for test clarity)
    let amount_withdrawn = setup.escrow.withdraw(&borrower, &goal_id);

    let borrower_balance_after = setup.token_client.balance(&borrower);

    // Assert borrower received principal + accrued yield
    assert_eq!(amount_withdrawn, total_assets_after);
    assert_eq!(borrower_balance_after - borrower_balance_before, total_assets_after);
    assert!(
        amount_withdrawn > deposit_amount,
        "Total withdrawn amount must include simulated yield"
    );
}

#[test]
fn test_proportional_share_minting_multi_deposit() {
    let env = Env::default();
    let setup = setup_protocol(&env, 1000); // 10% APY

    let borrower1 = Address::generate(&env);
    let borrower2 = Address::generate(&env);
    let goal1 = Symbol::new(&env, "goal1");
    let goal2 = Symbol::new(&env, "goal2");

    setup.sac.mint(&borrower1, &(10_000 * USDC));
    setup.sac.mint(&borrower2, &(10_000 * USDC));

    // Borrower 1 deposits 10,000 USDC
    setup.escrow.deposit(&borrower1, &(10_000 * USDC), &goal1);
    let shares1 = setup.vault.get_shares(&setup.escrow.address);
    assert_eq!(shares1, 10_000 * USDC);

    // Advance time by 6 months so exchange rate increases
    env.ledger().with_mut(|li| {
        li.sequence_number += SIX_MONTHS_LEDGERS;
    });

    // Borrower 2 deposits 10,000 USDC after yield accrued
    setup.escrow.deposit(&borrower2, &(10_000 * USDC), &goal2);

    let total_shares = setup.vault.get_shares(&setup.escrow.address);
    let shares2 = total_shares - shares1;

    // Borrower 2 should get FEWER shares for 10,000 USDC because share price increased
    assert!(
        shares2 < 10_000 * USDC,
        "Second deposit at higher exchange rate should mint proportionally fewer shares"
    );
}
