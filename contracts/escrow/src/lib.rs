#![no_std]

mod errors;
mod token_utils;
mod types;

#[cfg(test)]
pub mod test_utils;

#[cfg(test)]
mod fuzz_tests;

pub use crate::errors::EscrowError;
use crate::token_utils::get_token_client;
use crate::types::DataKey;
pub use crate::types::{BorrowerRecord, EscrowConfig, PendingUpgradeRecord, PendingPenaltyProposal};
use lending_pool::LendingPoolContractClient;
use soroban_sdk::{contract, contractimpl, symbol_short, xdr::ToXdr, Address, BytesN, Env, Symbol};

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

// Use a small constant in tests so ledger advances stay well within instance TTL.
#[cfg(not(test))]
const LEDGERS_PER_MONTH: u32 = 518_400; // ~30 days in production

#[cfg(test)]
const LEDGERS_PER_MONTH: u32 = 100; // compact constant for unit tests

///
/// Holds borrower contributions toward a 30% down-payment savings target.
/// Accepts USDC deposits, tracks individual balances, and releases funds
/// once the savings target is met — or refunds the borrower on early withdrawal.
#[contract]
pub struct EscrowContract;

/// Internal helpers.
impl EscrowContract {
    fn get_config(env: &Env) -> Result<EscrowConfig, EscrowError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(EscrowError::NotInitialized)
    }

    fn get_borrower(env: &Env, borrower: &Address, goal_id: &Symbol) -> BorrowerRecord {
        let config = Self::get_config(env).ok();
        let target_amount = config.map(|c| c.savings_target).unwrap_or(0);
        env.storage()
            .persistent()
            .get(&DataKey::Borrower(borrower.clone(), goal_id.clone()))
            .unwrap_or(BorrowerRecord {
                deposited: 0,
                start_ledger: 0,
                released: false,
                withdrawn: false,
                last_contribution_ledger: 0,
                target_amount,
            })
    }

    fn is_defaulting(record: &BorrowerRecord, config: &EscrowConfig, current_ledger: u32) -> bool {
        if record.deposited == 0 || record.released || record.withdrawn {
            return false;
        }
        let threshold = LEDGERS_PER_MONTH + config.grace_period_ledgers;
        let last = if record.last_contribution_ledger > 0 {
            record.last_contribution_ledger
        } else {
            record.start_ledger
        };
        current_ledger > last && (current_ledger - last) > threshold
    }

    fn set_borrower(env: &Env, borrower: &Address, goal_id: &Symbol, record: &BorrowerRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Borrower(borrower.clone(), goal_id.clone()), record);
    }

    fn read_total_pooled(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalPooled)
            .unwrap_or(0i128)
    }

    fn check_not_paused(env: &Env) -> Result<(), EscrowError> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            Err(EscrowError::ContractPaused)
        } else {
            Ok(())
        }
    }

    fn get_pending_penalty(env: &Env) -> Option<PendingPenaltyProposal> {
        env.storage()
            .instance()
            .get(&DataKey::PendingPenaltyTiers)
    }

    fn validate_penalty_tiers(tiers: (u32, u32, u32, u32)) -> Result<(), EscrowError> {
        let (t1, t2, t3, t4) = tiers;
        if t1 > 10000 || t2 > 10000 || t3 > 10000 || t4 > 10000 {
            Err(EscrowError::InvalidPenaltyBps)
        } else {
            Ok(())
        }
    }
}

#[contractimpl]
impl EscrowContract {
    pub fn initialize(env: Env, config: EscrowConfig) -> Result<(), EscrowError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(EscrowError::AlreadyInitialized);
        }

        if config.savings_target <= 0 {
            return Err(EscrowError::InvalidAmount);
        }

        config.admin.require_auth();

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().set(&DataKey::TotalPooled, &0i128);
        env.storage().instance().set(&DataKey::Version, &1u32);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    // ... (deposit, withdraw, release, release_and_request_loan, remove_defaulter, queries remain unchanged) ...

    /// Propose new early withdrawal penalty tiers (timelocked).
    pub fn propose_penalty_tiers(
        env: Env,
        tier1: u32,
        tier2: u32,
        tier3: u32,
        tier4: u32,
    ) -> Result<(), EscrowError> {
        let config = Self::get_config(&env)?;
        config.admin.require_auth();
        Self::validate_penalty_tiers((tier1, tier2, tier3, tier4))?;

        let delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeDelay)
            .unwrap_or(0u32);

        let current_ledger = env.ledger().sequence();
        let execute_after = current_ledger + delay;

        let proposal = PendingPenaltyProposal {
            tier1,
            tier2,
            tier3,
            tier4,
            execute_after,
        };

        env.storage()
            .instance()
            .set(&DataKey::PendingPenaltyTiers, &proposal);

        env.events().publish(
            (symbol_short!("pen_prop"),),
            (tier1, tier2, tier3, tier4, execute_after),
        );

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Execute pending penalty tier proposal after timelock.
    pub fn update_penalty_tiers(env: Env) -> Result<(), EscrowError> {
        let config = Self::get_config(&env)?;
        config.admin.require_auth();

        let pending = Self::get_pending_penalty(&env)
            .ok_or(EscrowError::PenaltyProposalNotPending)?;

        let current = env.ledger().sequence();
        if current < pending.execute_after {
            return Err(EscrowError::UpgradeTimelockActive);
        }

        let mut cfg = Self::get_config(&env)?;
        cfg.penalty_bps_tier1 = pending.tier1;
        cfg.penalty_bps_tier2 = pending.tier2;
        cfg.penalty_bps_tier3 = pending.tier3;
        cfg.penalty_bps_tier4 = pending.tier4;

        env.storage().instance().set(&DataKey::Config, &cfg);
        env.storage()
            .instance()
            .remove(&DataKey::PendingPenaltyTiers);

        env.events().publish(
            (symbol_short!("pen_upd"),),
            (pending.tier1, pending.tier2, pending.tier3, pending.tier4),
        );

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    pub fn get_pending_penalty_tiers(env: Env) -> Option<PendingPenaltyProposal> {
        Self::get_pending_penalty(&env)
    }

    // Existing upgrade, pause, admin transfer, and query functions remain...
    // (The rest of your original file continues here)
}