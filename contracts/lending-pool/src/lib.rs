#![no_std]

mod errors;
mod types;

use crate::errors::PoolError;
use crate::types::{DataKey, InvestorRecord, LoanRecord, LoanStatus, PoolConfig, RepaymentSchedule};
use soroban_sdk::{contract, contractimpl, token, Address, BytesN, Env};
use crate::types::{DataKey, InvestorRecord, LoanRecord, LoanStatus, PoolConfig};
use soroban_sdk::{contract, contractimpl, symbol_short, Symbol, token, Address, BytesN, Env, IntoVal};

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

// Ledger durations used for repayment scheduling
const LEDGERS_PER_MONTH: u32 = 518_400; // ~30 days
const GRACE_PERIOD_LEDGERS: u32 = 120_960; // ~7 days
const LATE_PENALTY_BPS: u32 = 50; // 50 bps = 0.5%
const DEFAULT_DURATION_MONTHS: u32 = 12;
const DEFAULT_MISSED_THRESHOLD: u32 = 3; // default after 3 missed payments

/// Lending Pool Contract
///
/// Holds capital from investors/depositors and provides the 70% loan
/// portion for borrowers whose escrow savings target has been met.
/// Supports loan requests, admin approval, milestone-based disbursement,
/// and borrower repayment.
#[contract]
pub struct LendingPoolContract;

/// Internal helpers.
impl LendingPoolContract {
    fn read_config(env: &Env) -> Result<PoolConfig, PoolError> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(PoolError::NotInitialized)
    }

    fn read_investor(env: &Env, investor: &Address) -> InvestorRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Investor(investor.clone()))
            .unwrap_or(InvestorRecord {
                deposited: 0,
                claimed_yield: 0,
                start_ledger: 0,
            })
    }

    fn set_investor(env: &Env, investor: &Address, record: &InvestorRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Investor(investor.clone()), record);
    }

    fn read_total_liquidity(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalLiquidity)
            .unwrap_or(0i128)
    }

    fn read_total_deposited(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalDeposited)
            .unwrap_or(0i128)
    }

    fn read_total_repaid_interest(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalRepaidInterest)
            .unwrap_or(0i128)
    }

    fn read_active_commitments(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::ActiveLoanCommitments)
            .unwrap_or(0i128)
    }

    fn read_loan(env: &Env, loan_id: &BytesN<32>) -> Result<LoanRecord, PoolError> {
        env.storage()
            .persistent()
            .get(&DataKey::Loan(loan_id.clone()))
            .ok_or(PoolError::LoanNotFound)
    }

    fn set_loan(env: &Env, loan_id: &BytesN<32>, record: &LoanRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id.clone()), record);
    }

    fn token_client<'a>(env: &'a Env, token_addr: &'a Address) -> token::Client<'a> {
        token::Client::new(env, token_addr)
    }
}

#[contractimpl]
impl LendingPoolContract {
    /// Initialize the lending pool contract.
    ///
    /// # Arguments
    /// - `admin` — Address authorized to approve loans and manage the pool.
    /// - `token` — USDC token contract address.
    /// - `interest_rate_bps` — Annual interest rate in basis points (e.g. 800 = 8%).
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        escrow: Address,
        interest_rate_bps: u32,
    ) -> Result<(), PoolError> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(PoolError::AlreadyInitialized);
        }

        admin.require_auth();

        let config = PoolConfig {
            admin,
            token,
            escrow,
            interest_rate_bps,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &0i128);
        env.storage().instance().set(&DataKey::LoanCount, &0u32);
        env.storage().instance().set(&DataKey::TotalRepaidInterest, &0i128);
        env.storage().instance().set(&DataKey::ActiveLoanCommitments, &0i128);
        env.storage().instance().set(&DataKey::TotalDeposited, &0i128);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Investor deposits capital into the lending pool.
    ///
    /// Transfers USDC from the investor to this contract and updates
    /// the investor's record and the pool's total liquidity.
    pub fn deposit(env: Env, investor: Address, amount: i128) -> Result<(), PoolError> {
        investor.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        let config = Self::read_config(&env)?;

        // Transfer USDC from investor to pool.
        let token = Self::token_client(&env, &config.token);
        token.transfer(&investor, &env.current_contract_address(), &amount);

        // Update investor record.
        let mut record = Self::read_investor(&env, &investor);
        if record.deposited == 0 {
            record.start_ledger = env.ledger().sequence();
        }
        record.deposited += amount;
        Self::set_investor(&env, &investor, &record);

        // Update total liquidity and total deposited.
        let total = Self::read_total_liquidity(&env) + amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &total);
        
        let total_dep = Self::read_total_deposited(&env) + amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &total_dep);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("deposit"),),
            (investor.clone(), amount, total),
        );

        Ok(())
    }

    /// Borrower requests a loan for the given principal amount.
    ///
    /// Creates a loan record in `Requested` state. The admin must
    /// approve it before any disbursement can happen.
    pub fn request_loan(
        env: Env,
        borrower: Address,
        loan_id: BytesN<32>,
        principal: i128,
    ) -> Result<(), PoolError> {
        borrower.require_auth();

        if principal <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // Ensure loan ID doesn't already exist.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Loan(loan_id.clone()))
        {
            return Err(PoolError::LoanAlreadyExists);
        }

        let config = Self::read_config(&env)?;

        let loan = LoanRecord {
            borrower,
            principal,
            disbursed: 0,
            repaid: 0,
            interest_rate_bps: config.interest_rate_bps,
            status: LoanStatus::Requested,
            created_ledger: env.ledger().sequence(),
        };

        Self::set_loan(&env, &loan_id, &loan);

        // Increment loan count.
        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0);
        env.storage()
            .instance()
            .set(&DataKey::LoanCount, &(count + 1));

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "loan_requested"),),
            (borrower.clone(), loan_id.clone(), principal),
        );

        Ok(())
    }

    /// Admin approves a pending loan request.
    ///
    /// Verifies that pool has sufficient liquidity for the loan principal,
    /// then transitions the loan status from Requested to Approved.
    pub fn approve_loan(env: Env, loan_id: BytesN<32>) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        let mut loan = Self::read_loan(&env, &loan_id)?;

        if loan.status != LoanStatus::Requested {
            return Err(PoolError::InvalidLoanState);
        }

        // Verify pool has enough liquidity accounting for active commitments.
        let liquidity = Self::read_total_liquidity(&env);
        let active_commitments = Self::read_active_commitments(&env);
        if liquidity - active_commitments < loan.principal {
            return Err(PoolError::InsufficientLiquidity);
        }

        // Transition to approved and generate a repayment schedule.
        // Calculate simple interest and distribute over default duration.
        let interest = (loan.principal * loan.interest_rate_bps as i128) / 10_000;
        let total_owed = loan.principal + interest;
        let duration_months = DEFAULT_DURATION_MONTHS;
        let monthly_amount = total_owed / (duration_months as i128);
        let next_due = env.ledger().sequence() + LEDGERS_PER_MONTH;

        loan.status = LoanStatus::Approved;

        let schedule = RepaymentSchedule {
            monthly_amount,
            duration_months,
            next_due_ledger: next_due,
            payments_made: 0u32,
            payments_missed: 0u32,
        };

        // Persist loan and schedule separately
        Self::set_loan(&env, &loan_id, &loan);
        env.storage()
            .persistent()
            .set(&DataKey::LoanSchedule(loan_id.clone()), &schedule);

        let new_commitments = active_commitments + loan.principal;
        env.storage().instance().set(&DataKey::ActiveLoanCommitments, &new_commitments);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (Symbol::new(&env, "loan_approved"),),
            (loan_id.clone(),),
        );

        Ok(())
    }

    /// Disburse funds from the pool for an approved loan.
    ///
    /// Transfers the specified amount to the recipient (e.g., a contractor
    /// or the milestone disbursement contract). Can be called multiple times
    /// for milestone-based releases up to the loan principal.
    pub fn disburse(
        env: Env,
        loan_id: BytesN<32>,
        recipient: Address,
        amount: i128,
    ) -> Result<(), PoolError> {
        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        let mut loan = Self::read_loan(&env, &loan_id)?;

        if loan.status != LoanStatus::Approved {
            return Err(PoolError::InvalidLoanState);
        }

        // Cannot disburse more than the remaining principal.
        if loan.disbursed + amount > loan.principal {
            return Err(PoolError::InvalidAmount);
        }

        // Verify pool liquidity.
        let liquidity = Self::read_total_liquidity(&env);
        if liquidity < amount {
            return Err(PoolError::InsufficientLiquidity);
        }

        // Transfer funds to recipient.
        let token = Self::token_client(&env, &config.token);
        token.transfer(&env.current_contract_address(), &recipient, &amount);

        loan.disbursed += amount;
        Self::set_loan(&env, &loan_id, &loan);

        // Reduce available liquidity.
        let new_liquidity = liquidity - amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &new_liquidity);

        // Reduce active loan commitments.
        let active_commitments = Self::read_active_commitments(&env);
        env.storage()
            .instance()
            .set(&DataKey::ActiveLoanCommitments, &(active_commitments - amount));

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("disburse"),),
            (loan_id.clone(), recipient.clone(), amount),
        );

        Ok(())
    }

    /// Borrower repays toward an approved loan.
    ///
    /// Transfers USDC from the borrower to the pool. Once the full
    /// principal + interest is repaid, the loan is marked as Repaid.
    pub fn repay(
        env: Env,
        borrower: Address,
        loan_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), PoolError> {
        borrower.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        let config = Self::read_config(&env)?;
        let mut loan = Self::read_loan(&env, &loan_id)?;

        if loan.status != LoanStatus::Approved {
            return Err(PoolError::InvalidLoanState);
        }

        // Calculate total owed (principal + simple interest).
        let interest = (loan.principal * loan.interest_rate_bps as i128) / 10_000;
        let total_owed = loan.principal + interest;
        let remaining = total_owed - loan.repaid;

        if amount > remaining {
            return Err(PoolError::OverPayment);
        }

        // If schedule exists, enforce installment logic (due dates, grace, penalties)
        if env.storage().persistent().has(&DataKey::LoanSchedule(loan_id.clone())) {
            let mut sched: RepaymentSchedule = env.storage().persistent().get(&DataKey::LoanSchedule(loan_id.clone())).unwrap();
            let current_ledger = env.ledger().sequence();

            // If payment is on-time or within grace period
            if current_ledger <= sched.next_due_ledger + GRACE_PERIOD_LEDGERS {
                // Accept payment. If it covers at least monthly_amount, count as on-time.
                if amount >= sched.monthly_amount {
                    sched.payments_made += 1u32;
                    sched.payments_missed = 0u32; // reset consecutive misses
                    sched.next_due_ledger = sched.next_due_ledger + LEDGERS_PER_MONTH;
                } else {
                    // partial payment within period: accept but do not advance schedule
                }
            } else {
                // Payment after grace period -> late.
                // Determine how many monthly periods have been missed up to now.
                let mut missed_periods: u32 = 1u32;
                if current_ledger > sched.next_due_ledger {
                    let diff = current_ledger - sched.next_due_ledger;
                    missed_periods = 1u32 + (diff / LEDGERS_PER_MONTH);
                }

                // Increase missed count by number of missed periods (consecutive)
                sched.payments_missed = sched.payments_missed.saturating_add(missed_periods);

                // Calculate penalty for overdue installment (50 bps of monthly_amount)
                let penalty = (sched.monthly_amount * LATE_PENALTY_BPS as i128) / 10_000;
                let required = sched.monthly_amount + penalty;

                if amount < required {
                    // enforce penalty-inclusive payment for late payments
                    return Err(PoolError::InvalidAmount);
                }

                // Treat this payment as covering the current installment and advance next_due accordingly
                sched.payments_made += 1u32;
                // Advance next_due by missed_periods + 1 months (we cover current and skipped installments)
                sched.next_due_ledger = sched.next_due_ledger + ((missed_periods + 1) * LEDGERS_PER_MONTH);

                // If missed threshold reached, it becomes eligible for default marking
                // which must be executed via `mark_default` to seize collateral.
            }

            // Persist schedule changes back to storage
            env.storage().persistent().set(&DataKey::LoanSchedule(loan_id.clone()), &sched);
        }

        // Transfer USDC from borrower to pool.
        let token = Self::token_client(&env, &config.token);
        token.transfer(&borrower, &env.current_contract_address(), &amount);

        let old_repaid = loan.repaid;
        loan.repaid += amount;

        let mut interest_paid = 0i128;
        if loan.repaid > loan.principal {
            let interest_start = if old_repaid > loan.principal {
                old_repaid
            } else {
                loan.principal
            };
            interest_paid = loan.repaid - interest_start;
        }

        if interest_paid > 0 {
            let total_interest = Self::read_total_repaid_interest(&env) + interest_paid;
            env.storage()
                .instance()
                .set(&DataKey::TotalRepaidInterest, &total_interest);
        }

        // Mark as repaid if fully paid.
        if loan.repaid >= total_owed {
            loan.status = LoanStatus::Repaid;
            
            // Release any undisbursed locked commitments
            let undisbursed = loan.principal - loan.disbursed;
            if undisbursed > 0 {
                let active_commitments = Self::read_active_commitments(&env);
                env.storage()
                    .instance()
                    .set(&DataKey::ActiveLoanCommitments, &(active_commitments - undisbursed));
            }
        }

        Self::set_loan(&env, &loan_id, &loan);

        // Increase available liquidity with the repayment.
        let liquidity = Self::read_total_liquidity(&env) + amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &liquidity);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("repay"),),
            (borrower.clone(), loan_id.clone(), amount, remaining - amount),
        );

        Ok(())
    }


    /// Trigger an on-chain liquidation for a defaulted loan.
    /// Allocates the seized savings collateral to the lending pool to cover investor losses.
    pub fn mark_default(env: Env, loan_id: BytesN<32>) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        let mut loan = Self::read_loan(&env, &loan_id)?;

        if loan.status == LoanStatus::Repaid || loan.status == LoanStatus::Cancelled {
            return Err(PoolError::InvalidLoanState);
        }
        if loan.status == LoanStatus::Defaulted {
            return Err(PoolError::AlreadyDefaulted);
        }

        if !env.storage().persistent().has(&DataKey::LoanSchedule(loan_id.clone())) {
            return Err(PoolError::InvalidLoanState);
        }

        let sched: RepaymentSchedule = env.storage().persistent().get(&DataKey::LoanSchedule(loan_id.clone())).unwrap();
        if sched.payments_missed < DEFAULT_MISSED_THRESHOLD {
            return Err(PoolError::NotEligibleForDefault);
        }

        // Seize collateral from escrow contract
        // Invokes: escrow::seize_collateral(borrower, lending_pool_address)
        let seized_amount: i128 = env.invoke_contract(
            &config.escrow,
            &soroban_sdk::Symbol::new(&env, "seize_collateral"),
            soroban_sdk::vec![&env, loan.borrower.into_val(&env), env.current_contract_address().into_val(&env)],
        );

        // Reduce outstanding defaulted loss using the seized savings balance
        loan.repaid += seized_amount;
        loan.status = LoanStatus::Defaulted;
        Self::set_loan(&env, &loan_id, &loan);

        // Update lending pool total liquidity
        let mut liquidity = Self::read_total_liquidity(&env);
        liquidity += seized_amount;
        env.storage().instance().set(&DataKey::TotalLiquidity, &liquidity);

        // Release undisbursed active commitments
        let undisbursed = loan.principal - loan.disbursed;
        if undisbursed > 0 {
            let active_commitments = Self::read_active_commitments(&env);
            env.storage()
                .instance()
                .set(&DataKey::ActiveLoanCommitments, &(active_commitments - undisbursed));
        }

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (soroban_sdk::symbol_short!("default"),),
            (loan_id.clone(), loan.borrower.clone(), seized_amount),
        );

        Ok(())
    }

    /// Investor withdraws available capital.
    pub fn withdraw(env: Env, investor: Address, amount: i128) -> Result<(), PoolError> {
        investor.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        let mut record = Self::read_investor(&env, &investor);
        if record.deposited < amount {
            return Err(PoolError::InsufficientBalance);
        }

        let liquidity = Self::read_total_liquidity(&env);
        let active_commitments = Self::read_active_commitments(&env);
        let available_liquidity = liquidity - active_commitments;

        if available_liquidity < amount {
            return Err(PoolError::InsufficientLiquidity);
        }

        let config = Self::read_config(&env)?;
        
        // Update state first
        record.deposited -= amount;
        Self::set_investor(&env, &investor, &record);

        let new_liquidity = liquidity - amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &new_liquidity);

        let total_dep = Self::read_total_deposited(&env) - amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &total_dep);

        // Transfer funds back to investor
        let token = Self::token_client(&env, &config.token);
        token.transfer(&env.current_contract_address(), &investor, &amount);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Investor claims their proportional share of repaid interest.
    pub fn claim_yield(env: Env, investor: Address) -> Result<i128, PoolError> {
        investor.require_auth();

        let mut record = Self::read_investor(&env, &investor);
        if record.deposited == 0 && record.claimed_yield == 0 {
            return Err(PoolError::InsufficientBalance);
        }

        let pending_yield = Self::calculate_pending_yield(&env, &record);
        if pending_yield <= 0 {
            return Ok(0);
        }

        let config = Self::read_config(&env)?;

        // Update state
        record.claimed_yield += pending_yield;
        Self::set_investor(&env, &investor, &record);

        let liquidity = Self::read_total_liquidity(&env) - pending_yield;
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &liquidity);

        // Transfer yield
        let token = Self::token_client(&env, &config.token);
        token.transfer(&env.current_contract_address(), &investor, &pending_yield);

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(pending_yield)
    }

    // ── Query Functions ──────────────────────────────────────────────────

    fn calculate_pending_yield(env: &Env, record: &InvestorRecord) -> i128 {
        let total_dep = Self::read_total_deposited(env);
        if total_dep == 0 {
            return 0;
        }

        let total_interest = Self::read_total_repaid_interest(env);
        
        // Math: (investor.deposited * total_interest) / total_deposited
        // Note: Using point-in-time calculation as accepted in the implementation plan
        let share = (record.deposited * total_interest) / total_dep;
        
        if share > record.claimed_yield {
            share - record.claimed_yield
        } else {
            0
        }
    }

    /// Returns the pool configuration.
    pub fn get_pool_config(env: Env) -> Result<PoolConfig, PoolError> {
        Self::read_config(&env)
    }

    /// Returns the total available liquidity.
    pub fn get_liquidity(env: Env) -> i128 {
        Self::read_total_liquidity(&env)
    }

    /// Returns the maximum amount an investor can currently withdraw.
    pub fn get_available_withdrawal(env: Env, investor: Address) -> i128 {
        let record = Self::read_investor(&env, &investor);
        let liquidity = Self::read_total_liquidity(&env);
        let active_commitments = Self::read_active_commitments(&env);
        
        let available = liquidity - active_commitments;
        if available < 0 {
            return 0;
        }
        
        if record.deposited < available {
            record.deposited
        } else {
            available
        }
    }

    /// Returns the amount of yield available to claim.
    pub fn get_pending_yield(env: Env, investor: Address) -> i128 {
        let record = Self::read_investor(&env, &investor);
        Self::calculate_pending_yield(&env, &record)
    }

    /// Returns an investor's record.
    pub fn get_investor_info(env: Env, investor: Address) -> InvestorRecord {
        Self::read_investor(&env, &investor)
    }

    /// Returns a loan record by ID.
    pub fn get_loan_info(env: Env, loan_id: BytesN<32>) -> Result<LoanRecord, PoolError> {
        Self::read_loan(&env, &loan_id)
    }

    /// Returns repayment schedule for a loan (if one exists).
    pub fn get_repayment_schedule(env: Env, loan_id: BytesN<32>) -> Result<Option<RepaymentSchedule>, PoolError> {
        if env.storage().persistent().has(&DataKey::LoanSchedule(loan_id.clone())) {
            let sched: RepaymentSchedule = env.storage().persistent().get(&DataKey::LoanSchedule(loan_id.clone())).unwrap();
            Ok(Some(sched))
        } else {
            Ok(None)
        }
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Env};

    /// Helper: deploy test token, mint to investor, initialize pool.
    fn setup_pool(env: &Env) -> (Address, Address, Address, Address, LendingPoolContractClient<\'_>) {
        let admin = Address::generate(env);
        let investor = Address::generate(env);

        // Deploy test USDC.
        let token_admin = Address::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();
        let sac = StellarAssetClient::new(env, &token_address);

        // Mint 100,000 USDC to investor.
        sac.mint(&investor, &100_000_0000000i128);
        let escrow = Address::generate(env);

        let contract_id = env.register(LendingPoolContract, ());
        let client = LendingPoolContractClient::new(env, &contract_id);
        client.initialize(&admin, &token_address, &escrow, &800u32); // 8% interest

        (admin, investor, token_address, escrow, client)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, token_address, _escrow, client) = setup_pool(&env);

        let config = client.get_pool_config();
        assert_eq!(config.admin, admin);
        assert_eq!(config.token, token_address);
        assert_eq!(config.interest_rate_bps, 800u32);
        assert_eq!(client.get_liquidity(), 0);
    }

    #[test]
    fn test_deposit() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);

        client.deposit(&investor, &50_000_0000000i128);

        assert_eq!(client.get_liquidity(), 50_000_0000000i128);
        assert_eq!(token.balance(&client.address), 50_000_0000000i128);

        let info = client.get_investor_info(&investor);
        assert_eq!(info.deposited, 50_000_0000000i128);
    }

    #[test]
    fn test_deposit_zero_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);

        let result = client.try_deposit(&investor, &0i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, token_address, _escrow, client) = setup_pool(&env);

        let result = client.try_initialize(&admin, &token_address, &_escrow, &800u32);
        assert!(result.is_err());
    }

    fn mock_loan_id(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[1u8; 32])
    }

    #[test]
    fn test_request_and_approve_loan() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Fund the pool.
        client.deposit(&investor, &70_000_0000000i128);

        // Borrower requests a 70,000 USDC loan.
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);
        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Requested);
        assert_eq!(loan.principal, 70_000_0000000i128);
        assert_eq!(loan.borrower, borrower);

        // Verify request_loan event
        let events = env.events().all();
        let last_event = events.last().unwrap();
        
        let expected_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![&env, Symbol::new(&env, "loan_requested").into_val(&env)];
        assert_eq!(last_event.1, expected_topic);
        
        let expected_data: soroban_sdk::Val = (borrower.clone(), loan_id.clone(), 70_000_0000000i128).into_val(&env);
        assert_eq!(last_event.2, expected_data);

        // Admin approves.
        client.approve_loan(&loan_id);
        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Approved);
    }

    #[test]
    fn test_approve_insufficient_liquidity_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Only deposit 5,000 but request 70,000.
        client.deposit(&investor, &5_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);

        let result = client.try_approve_loan(&loan_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_duplicate_loan_id_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &70_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);

        // Same loan ID should fail.
        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_version() {
        let env = Env::default();
        let contract_id = env.register(LendingPoolContract, ());
        let client = LendingPoolContractClient::new(&env, &contract_id);
        assert_eq!(client.version(), 1);
    }

    #[test]
    fn test_disburse_and_repay_full_lifecycle() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);
        let borrower = Address::generate(&env);
        let contractor = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Fund the pool.
        client.deposit(&investor, &70_000_0000000i128);

        // Request + approve loan.
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);
        client.approve_loan(&loan_id);

        // Disburse 30,000 to contractor (first milestone).
        client.disburse(&loan_id, &contractor, &30_000_0000000i128);
        assert_eq!(token.balance(&contractor), 30_000_0000000i128);
        assert_eq!(client.get_liquidity(), 40_000_0000000i128);

        // Disburse remaining 40,000.
        client.disburse(&loan_id, &contractor, &40_000_0000000i128);
        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.disbursed, 70_000_0000000i128);

        // Borrower repays. Total owed = 70,000 + 8% = 75,600.
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&borrower, &80_000_0000000i128);

        client.repay(&borrower, &loan_id, &75_600_0000000i128);
        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Repaid);
        assert_eq!(loan.repaid, 75_600_0000000i128);
    }

    #[test]
    fn test_disburse_over_principal_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let contractor = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);

        // Try to disburse more than principal.
        let result = client.try_disburse(&loan_id, &contractor, &20_000_0000000i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_repay_overpayment_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);

        // Mint USDC to borrower for repayment.
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&borrower, &20_000_0000000i128);

        // Total owed = 10,000 + 8% = 10,800. Try to repay 15,000.
        let result = client.try_repay(&borrower, &loan_id, &15_000_0000000i128);
        assert!(result.is_err());
    }

    #[test]
    fn test_withdraw() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);

        client.deposit(&investor, &50_000_0000000i128);
        
        // Investor withdraws 20,000
        client.withdraw(&investor, &20_000_0000000i128);

        assert_eq!(client.get_liquidity(), 30_000_0000000i128);
        
        let record = client.get_investor_info(&investor);
        assert_eq!(record.deposited, 30_000_0000000i128);
        assert_eq!(token.balance(&investor), 70_000_0000000i128); // Started with 100k, deposited 50k, withdrew 20k
    }

    #[test]
    fn test_withdraw_exceeds_liquidity() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128);
        
        // Active loan commitment consumes 40,000 liquidity
        client.request_loan(&borrower, &loan_id, &40_000_0000000i128);
        client.approve_loan(&loan_id);

        // Available withdrawal is 50,000 - 40,000 = 10,000
        assert_eq!(client.get_available_withdrawal(&investor), 10_000_0000000i128);

        // Attempting to withdraw 20,000 should fail
        let result = client.try_withdraw(&investor, &20_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(soroban_sdk::Error::from_contract_error(9))); // InsufficientLiquidity = 9
    }

    #[test]
    fn test_yield_distribution() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor1, token_address, _escrow, client) = setup_pool(&env);
        
        // Setup investor 2
        let investor2 = Address::generate(&env);
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&investor2, &100_000_0000000i128);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Investor 1 & 2 each deposit 50,000 (50% share)
        client.deposit(&investor1, &50_000_0000000i128);
        client.deposit(&investor2, &50_000_0000000i128);

        client.request_loan(&borrower, &loan_id, &100_000_0000000i128);
        client.approve_loan(&loan_id);
        
        sac.mint(&borrower, &110_000_0000000i128); // Fund borrower to repay
        client.repay(&borrower, &loan_id, &108_000_0000000i128); // 100k principal + 8k interest

        // Check pending yield (each should get 4k)
        assert_eq!(client.get_pending_yield(&investor1), 4_000_0000000i128);
        assert_eq!(client.get_pending_yield(&investor2), 4_000_0000000i128);

        let bal1_before = StellarAssetClient::new(&env, &token_address).balance(&investor1);
        client.claim_yield(&investor1);
        let bal1_after = StellarAssetClient::new(&env, &token_address).balance(&investor1);
        
        assert_eq!(bal1_after - bal1_before, 4_000_0000000i128);
        
        let record = client.get_investor_info(&investor1);
        assert_eq!(record.claimed_yield, 4_000_0000000i128);
    }

    #[test]
    fn test_double_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &100_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);

        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&borrower, &20_000_0000000i128);
        client.repay(&borrower, &loan_id, &10_800_0000000i128);

        let claimed = client.claim_yield(&investor);
        assert_eq!(claimed, 800_0000000i128);

        // Double claim should return 0
        let claimed_second = client.claim_yield(&investor);
        assert_eq!(claimed_second, 0);
    }

    #[test]
    fn test_withdrawal_after_yield() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &100_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);

        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&borrower, &20_000_0000000i128);
        client.repay(&borrower, &loan_id, &10_800_0000000i128);

        client.claim_yield(&investor);

        // Now withdraw
        client.withdraw(&investor, &50_000_0000000i128);

        let record = client.get_investor_info(&investor);
        assert_eq!(record.deposited, 50_000_0000000i128);
        assert_eq!(record.claimed_yield, 800_0000000i128);
    }


    #[contract]
    pub struct MockEscrow;

    #[contractimpl]
    impl MockEscrow {
        pub fn seize_collateral(env: Env, _borrower: Address, lending_pool_address: Address) -> i128 {
            // Mock transferring 5000 USDC
            let token_address = env.storage().instance().get(&symbol_short!("token")).unwrap();
            let sac = StellarAssetClient::new(&env, &token_address);
            // In a real scenario we'd use transfer, but in test we can just mint to the lending pool to simulate seized funds
            sac.mint(&lending_pool_address, &5_000_0000000i128);
            5_000_0000000i128
        }
        pub fn set_token(env: Env, token: Address) {
            env.storage().instance().set(&symbol_short!("token"), &token);
        }
    }

    #[test]
    fn test_mark_default() {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let investor = Address::generate(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        let token_admin = Address::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let token_address = token_id.address();
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&investor, &100_000_0000000i128);

        let escrow_id = env.register(MockEscrow, ());
        let mock_escrow = escrow_id.clone();
        
        // Setup mock escrow token
        env.invoke_contract::<()>(&escrow_id, &symbol_short!("set_token"), soroban_sdk::vec![&env, token_address.into_val(&env)]);

        let contract_id = env.register(LendingPoolContract, ());
        let client = LendingPoolContractClient::new(&env, &contract_id);
        client.initialize(&admin, &token_address, &mock_escrow, &800u32);

        client.deposit(&investor, &70_000_0000000i128);
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);
        client.approve_loan(&loan_id);

        client.disburse(&loan_id, &borrower, &30_000_0000000i128);

        // Advance schedule to have missed 3 payments
        let mut sched: RepaymentSchedule = env.as_contract(&contract_id, || {
            env.storage().persistent().get(&DataKey::LoanSchedule(loan_id.clone())).unwrap()
        });
        sched.payments_missed = 3;
        env.as_contract(&contract_id, || {
            env.storage().persistent().set(&DataKey::LoanSchedule(loan_id.clone()), &sched);
        });

        // Trigger default
        client.mark_default(&loan_id);

        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Defaulted);
        assert_eq!(loan.repaid, 5_000_0000000i128); // 5000 seized from mock escrow

        // Verify active commitments are reduced by undisbursed (70000 - 30000 = 40000)
        // Original commitments: 70000. After disburse: 40000. After default: 0.
        // Also liquidity increased by 5000 seized collateral.
        let liquidity = client.get_liquidity();
        assert_eq!(liquidity, 45_000_0000000i128); // 70000 - 30000 + 5000
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_unauthorized_withdrawal() {
        let env = Env::default();

        let (_admin, _investor, _token_address, _escrow, client) = setup_pool(&env);
        let unauthorized = Address::generate(&env);
        
        // This will panic because unauthorized doesn't have auth mocked.
        client.withdraw(&unauthorized, &10_000_0000000i128);
    }
}
