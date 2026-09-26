// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Borrower-authorized recurring escrow deposits (#635).
//!
//! A borrower configures a schedule (amount + interval) and approves a token
//! allowance for this contract. Once each interval elapses, anyone — typically
//! a keeper bot — can call `execute_auto_deposit` to pull the scheduled amount
//! from that allowance into the borrower's goal, so savings accumulate without
//! a manual transaction every month.

use crate::errors::EscrowError;
use crate::token_utils::get_token_client;
use crate::types::{AutoDepositSchedule, DataKey};
use crate::{EscrowContract, EscrowContractArgs, EscrowContractClient};
use soroban_sdk::{contractimpl, symbol_short, Address, Env, IntoVal, Symbol};

impl EscrowContract {
    fn auto_deposit_key(borrower: &Address, goal_id: &Symbol) -> DataKey {
        DataKey::AutoDeposit(borrower.clone(), goal_id.clone())
    }

    fn read_auto_deposit(
        env: &Env,
        borrower: &Address,
        goal_id: &Symbol,
    ) -> Option<AutoDepositSchedule> {
        env.storage()
            .persistent()
            .get(&Self::auto_deposit_key(borrower, goal_id))
    }

    fn write_auto_deposit(
        env: &Env,
        borrower: &Address,
        goal_id: &Symbol,
        schedule: &AutoDepositSchedule,
    ) {
        let key = Self::auto_deposit_key(borrower, goal_id);
        env.storage().persistent().set(&key, schedule);
        Self::extend_persistent_ttl(env, &key);
    }
}

#[contractimpl]
impl EscrowContract {
    /// Configure (or replace) a recurring auto-deposit for a borrower's goal.
    ///
    /// The first draw becomes executable `interval_ledgers` after this call.
    /// The borrower must separately `approve` this contract on the token for
    /// at least `amount` per draw; the schedule itself moves no funds.
    pub fn configure_auto_deposit(
        env: Env,
        borrower: Address,
        goal_id: Symbol,
        amount: i128,
        interval_ledgers: u32,
    ) -> Result<(), EscrowError> {
        borrower.require_auth();
        Self::check_not_paused(&env)?;
        Self::check_whitelist(&env, &borrower)?;

        if amount <= 0 {
            return Err(EscrowError::InvalidAmount);
        }
        if interval_ledgers == 0 {
            return Err(EscrowError::InvalidAutoDepositInterval);
        }

        let record = Self::get_borrower(&env, &borrower, &goal_id);
        if record.released {
            return Err(EscrowError::AlreadyReleased);
        }
        if record.withdrawn {
            return Err(EscrowError::AlreadyWithdrawn);
        }
        if record.seized {
            return Err(EscrowError::AlreadySeized);
        }

        let schedule = AutoDepositSchedule {
            amount,
            interval_ledgers,
            next_execution_ledger: env.ledger().sequence().saturating_add(interval_ledgers),
        };
        Self::write_auto_deposit(&env, &borrower, &goal_id, &schedule);
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("auto_cfg"), goal_id),
            (borrower, amount, interval_ledgers),
        );
        Ok(())
    }

    /// Cancel a borrower's auto-deposit schedule. Revoking the token allowance
    /// has the same practical effect; this also clears the schedule state.
    pub fn cancel_auto_deposit(
        env: Env,
        borrower: Address,
        goal_id: Symbol,
    ) -> Result<(), EscrowError> {
        borrower.require_auth();
        if Self::read_auto_deposit(&env, &borrower, &goal_id).is_none() {
            return Err(EscrowError::AutoDepositNotConfigured);
        }
        env.storage()
            .persistent()
            .remove(&Self::auto_deposit_key(&borrower, &goal_id));

        env.events()
            .publish((symbol_short!("auto_cxl"), goal_id), borrower);
        Ok(())
    }

    /// Execute a due auto-deposit. Permissionless: the borrower authorized the
    /// schedule and the allowance up front, so any caller may trigger the draw.
    ///
    /// Fails without side effects if no schedule exists, the interval has not
    /// elapsed, or the borrower's allowance or balance is below the amount.
    /// Returns the borrower's new deposited total.
    pub fn execute_auto_deposit(
        env: Env,
        borrower: Address,
        goal_id: Symbol,
    ) -> Result<i128, EscrowError> {
        Self::check_not_paused(&env)?;
        Self::check_whitelist(&env, &borrower)?;

        let mut schedule = Self::read_auto_deposit(&env, &borrower, &goal_id)
            .ok_or(EscrowError::AutoDepositNotConfigured)?;

        let current_ledger = env.ledger().sequence();
        if current_ledger < schedule.next_execution_ledger {
            return Err(EscrowError::AutoDepositNotDue);
        }

        let config = Self::get_config(&env)?;
        let mut record = Self::get_borrower(&env, &borrower, &goal_id);
        if record.released {
            return Err(EscrowError::AlreadyReleased);
        }
        if record.withdrawn {
            return Err(EscrowError::AlreadyWithdrawn);
        }
        if record.seized {
            return Err(EscrowError::AlreadySeized);
        }

        let token = get_token_client(&env, &config.token);
        let escrow = env.current_contract_address();
        if token.allowance(&borrower, &escrow) < schedule.amount {
            return Err(EscrowError::InsufficientAllowance);
        }
        if token.balance(&borrower) < schedule.amount {
            return Err(EscrowError::InsufficientBalance);
        }

        token.transfer_from(&escrow, &borrower, &escrow, &schedule.amount);

        if let Some(vault) = &config.yield_vault {
            let invoke_args =
                soroban_sdk::vec![&env, escrow.into_val(&env), schedule.amount.into_val(&env)];
            let shares: i128 =
                env.invoke_contract(vault, &Symbol::new(&env, "deposit"), invoke_args);
            record.yield_shares += shares;
            let total_shares = Self::read_total_yield_shares(&env) + shares;
            env.storage()
                .instance()
                .set(&DataKey::TotalYieldShares, &total_shares);
        }

        if record.deposited == 0 {
            record.start_ledger = current_ledger;
        }
        // A scheduled draw is a regular contribution, so it resets the default timer.
        record.last_contribution_ledger = current_ledger;
        record.deposited += schedule.amount;
        Self::set_borrower(&env, &borrower, &goal_id, &record);

        let total = Self::read_total_pooled(&env) + schedule.amount;
        env.storage().instance().set(&DataKey::TotalPooled, &total);

        // Anchor the next draw to now rather than the missed slot, so a keeper
        // that falls behind cannot fire several back-to-back catch-up draws.
        schedule.next_execution_ledger = current_ledger.saturating_add(schedule.interval_ledgers);
        Self::write_auto_deposit(&env, &borrower, &goal_id, &schedule);
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (symbol_short!("auto_dep"), goal_id),
            (borrower, schedule.amount, record.deposited),
        );
        Ok(record.deposited)
    }

    /// Current auto-deposit schedule for a borrower's goal, if any.
    pub fn get_auto_deposit(
        env: Env,
        borrower: Address,
        goal_id: Symbol,
    ) -> Option<AutoDepositSchedule> {
        Self::read_auto_deposit(&env, &borrower, &goal_id)
    }
}
