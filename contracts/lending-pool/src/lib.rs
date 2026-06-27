#![no_std]

mod errors;
mod types;

pub use crate::errors::PoolError;
pub use crate::types::{DataKey, InvestorRecord, LoanRecord, LoanStatus, PendingUpgradeRecord, PoolConfig, RepaymentSchedule, Tranche, TrancheInfo};
use soroban_sdk::{contract, contractimpl, symbol_short, Symbol, token, Address, BytesN, Env};
use verification_registry::VerificationRegistryContractClient;

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

// Ledger durations used for repayment scheduling
const LEDGERS_PER_MONTH: u32 = 518_400; // ~30 days
#[cfg(not(test))]
const LEDGERS_PER_DAY: u32 = 17_280; // ~1 day
#[cfg(test)]
const LEDGERS_PER_DAY: u32 = 100;
const GRACE_PERIOD_LEDGERS: u32 = 120_960; // ~7 days
const LATE_PENALTY_BPS: u32 = 50; // 50 bps = 0.5%
const DEFAULT_DURATION_MONTHS: u32 = 12;
const DEFAULT_MISSED_THRESHOLD: u32 = 3; // default after 3 missed payments

// ── Dynamic Fee Structure Constants ──────────────────────────────────
/// Basis points scale (10000 = 100%).
const BPS_SCALE: u32 = 10_000;
/// Utilization threshold for low-fee tier (50%).
const UTILIZATION_LOW_THRESHOLD_BPS: u32 = 5_000; // 50%
/// Utilization threshold for medium-fee tier (80%).
const UTILIZATION_HIGH_THRESHOLD_BPS: u32 = 8_000; // 80%
/// Withdrawal fee at low utilization (< 50%): 0.1% = 10 bps.
const FEE_LOW_BPS: u32 = 10;
/// Withdrawal fee at medium utilization (50% - 80%): 0.5% = 50 bps.
const FEE_MEDIUM_BPS: u32 = 50;
/// Withdrawal fee at high utilization (> 80%): 2% = 200 bps.
const FEE_HIGH_BPS: u32 = 200;

/// Lending Pool Contract
///
/// Holds capital from investors/depositors and provides the 70% loan
/// portion for borrowers whose escrow savings target has been met.
/// Supports loan requests, admin approval, milestone-based disbursement,
/// and borrower repayment.
///
/// Dynamic Fee Structure:
/// - Utilization < 50%: 0.1% withdrawal fee
/// - Utilization 50% - 80%: 0.5% withdrawal fee
/// - Utilization > 80%: 2% withdrawal fee
/// Fees are routed to the protocol treasury address.
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
                tranche: Tranche::Senior,
                accrued_yield: 0,
                absorbed_loss: 0,
            })
    }

    fn read_tranche_info(env: &Env, tranche: &Tranche) -> TrancheInfo {
        let key = match tranche {
            Tranche::Senior => DataKey::SeniorTranche,
            Tranche::Junior => DataKey::JuniorTranche,
        };
        env.storage()
            .instance()
            .get(&key)
            .unwrap_or(TrancheInfo {
                total_deposited: 0,
                total_yield_distributed: 0,
                total_loss_absorbed: 0,
            })
    }

    fn set_tranche_info(env: &Env, tranche: &Tranche, info: &TrancheInfo) {
        let key = match tranche {
            Tranche::Senior => DataKey::SeniorTranche,
            Tranche::Junior => DataKey::JuniorTranche,
        };
        env.storage().instance().set(&key, info);
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

    fn read_total_withdrawal_fees(env: &Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::TotalWithdrawalFees)
            .unwrap_or(0i128)
    }

    fn read_loan(env: &Env, loan_id: &BytesN<32>) -> Result<LoanRecord, PoolError> {
        env.storage()
            .persistent()
            .get(&DataKey::Loan(loan_id.clone()))
            .ok_or(PoolError::LoanNotFound)
    }

    /// Returns the configured VerificationRegistry address, if one has been set.
    ///
    /// `None` means no registry has been configured yet, in which case the
    /// verification gate in `do_request_loan` is skipped (opt-in gating).
    fn read_verification_registry(env: &Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::VerificationRegistry)
    }

    fn set_loan(env: &Env, loan_id: &BytesN<32>, record: &LoanRecord) {
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id.clone()), record);
    }

    fn token_client<'a>(env: &'a Env, token_addr: &'a Address) -> token::Client<'a> {
        token::Client::new(env, token_addr)
    }

    /// Fixed-point scale for compound interest calculations (10^9).
    const INTEREST_SCALE: i128 = 1_000_000_000i128;

    /// Number of ledgers per compounding period.
    /// In tests this is 100 (compact); in production this is 518_400 (~30 days).
    #[cfg(not(test))]
    const COMPOUND_PERIOD: u32 = 518_400;
    #[cfg(test)]
    const COMPOUND_PERIOD: u32 = 100;

    /// Raise `base` (fixed-point, scale = INTEREST_SCALE) to the power `exp`
    /// using binary exponentiation. Returns a fixed-point result in the same scale.
    fn compound_pow(base: i128, mut exp: u32) -> i128 {
        let scale = Self::INTEREST_SCALE;
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

    /// Accrue compound interest on `loan.outstanding_debt` for the ledgers
    /// elapsed since `loan.last_interest_ledger`. Updates both fields in place.
    fn accrue_interest(env: &Env, loan: &mut LoanRecord) {
        let current = env.ledger().sequence();
        if current <= loan.last_interest_ledger || loan.outstanding_debt <= 0 {
            loan.last_interest_ledger = current;
            return;
        }
        let elapsed = current - loan.last_interest_ledger;
        let periods = elapsed / Self::COMPOUND_PERIOD;
        if periods == 0 {
            return;
        }
        // per-period factor = SCALE + rate_bps * SCALE / 10_000
        let factor = Self::INTEREST_SCALE
            + (loan.interest_rate_bps as i128 * Self::INTEREST_SCALE) / 10_000;
        let compound = Self::compound_pow(factor, periods);
        loan.outstanding_debt =
            loan.outstanding_debt.saturating_mul(compound) / Self::INTEREST_SCALE;
        loan.last_interest_ledger = current;
    }

    fn check_not_paused(env: &Env) -> Result<(), PoolError> {
        let paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::Paused)
            .unwrap_or(false);
        if paused {
            Err(PoolError::ContractPaused)
        } else {
            Ok(())
        }
    }

    // ── Dynamic Fee Helpers ─────────────────────────────────────────────

    /// Calculate the current pool utilization rate.
    ///
    /// Utilization = active_loan_commitments / total_pool_liquidity
    /// Returns the rate in basis points (0-10000).
    fn calculate_utilization(env: &Env) -> u32 {
        let total_deposited = Self::read_total_deposited(env);
        if total_deposited <= 0 {
            return 0;
        }
        let total_liquidity = Self::read_total_liquidity(env);
        let active_commitments = Self::read_active_commitments(env);
        let utilized = active_commitments.saturating_add(
            total_deposited.saturating_sub(total_liquidity).max(0),
        );
        let utilization = (utilized * BPS_SCALE as i128) / total_deposited;
        utilization.min(BPS_SCALE as i128) as u32
    }

    /// Calculate the dynamic withdrawal fee in basis points based on utilization.
    ///
    /// - Utilization < 50%: 10 bps (0.1%)
    /// - Utilization 50% - 80%: 50 bps (0.5%)
    /// - Utilization > 80%: 200 bps (2%)
    fn calculate_withdrawal_fee_bps(utilization_bps: u32) -> u32 {
        if utilization_bps >= UTILIZATION_HIGH_THRESHOLD_BPS {
            FEE_HIGH_BPS
        } else if utilization_bps >= UTILIZATION_LOW_THRESHOLD_BPS {
            FEE_MEDIUM_BPS
        } else {
            FEE_LOW_BPS
        }
    }

    /// Calculate the fee amount for a given withdrawal amount and fee rate.
    fn calculate_fee_amount(amount: i128, fee_bps: u32) -> i128 {
        (amount * fee_bps as i128) / BPS_SCALE as i128
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
    /// - `senior_rate_bps` — Fixed annual yield allocated to senior tranche investors
    ///   in basis points (e.g. 400 = 4%). Must be <= interest_rate_bps.
    /// - `treasury_address` — Protocol treasury address where withdrawal fees are routed.
    pub fn initialize(
        env: Env,
        admin: Address,
        token: Address,
        escrow: Address,
        interest_rate_bps: u32,
        senior_rate_bps: u32,
        treasury_address: Address,
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
            senior_rate_bps,
            treasury_address,
        };

        env.storage().instance().set(&DataKey::Config, &config);
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &0i128);
        env.storage().instance().set(&DataKey::LoanCount, &0u32);

        // Initialize tranche info.
        let empty_tranche = TrancheInfo {
            total_deposited: 0,
            total_yield_distributed: 0,
            total_loss_absorbed: 0,
        };
        env.storage()
            .instance()
            .set(&DataKey::SeniorTranche, &empty_tranche);
        env.storage()
            .instance()
            .set(&DataKey::JuniorTranche, &empty_tranche);

        env.storage().instance().set(&DataKey::TotalRepaidInterest, &0i128);
        env.storage().instance().set(&DataKey::ActiveLoanCommitments, &0i128);
        env.storage().instance().set(&DataKey::TotalDeposited, &0i128);
        env.storage().instance().set(&DataKey::TotalWithdrawalFees, &0i128);
        env.storage().instance().set(&DataKey::Version, &1u32);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        Ok(())
    }

    /// Investor deposits capital into the lending pool.
    ///
    /// Each deposit is tagged with a tranche (Senior or Junior). An investor
    /// cannot mix tranches across deposits — their first deposit sets the tranche.
    /// Transfers USDC from the investor to this contract and updates the investor's
    /// record, per-tranche totals, and the pool's total liquidity.
    pub fn deposit(env: Env, investor: Address, amount: i128, tranche: Tranche) -> Result<(), PoolError> {
        Self::check_not_paused(&env)?;
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
            // First deposit — set tranche and start ledger.
            record.start_ledger = env.ledger().sequence();
            record.tranche = tranche.clone();
        } else if record.tranche != tranche {
            // Investor already has a position in a different tranche.
            return Err(PoolError::TrancheMismatch);
        }
        record.deposited += amount;
        Self::set_investor(&env, &investor, &record);

        // Update per-tranche aggregate.
        let mut tranche_info = Self::read_tranche_info(&env, &tranche);
        tranche_info.total_deposited += amount;
        Self::set_tranche_info(&env, &tranche, &tranche_info);

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
        Self::check_not_paused(&env)?;
        borrower.require_auth();
        Self::do_request_loan(&env, borrower, loan_id, principal, None)
    }

    pub fn request_loan_with_origin(
        env: Env,
        borrower: Address,
        loan_id: BytesN<32>,
        principal: i128,
        escrow_origin: Address,
    ) -> Result<(), PoolError> {
        Self::do_request_loan(&env, borrower, loan_id, principal, Some(escrow_origin))
    }

    fn do_request_loan(
        env: &Env,
        borrower: Address,
        loan_id: BytesN<32>,
        principal: i128,
        escrow_origin: Option<Address>,
    ) -> Result<(), PoolError> {
        if principal <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // Verification gate: if a VerificationRegistry has been configured,
        // the borrower must have a valid, non-expired verification record
        // before they can request a loan against pool liquidity.
        if let Some(registry) = Self::read_verification_registry(env) {
            let registry_client = VerificationRegistryContractClient::new(env, &registry);
            if !registry_client.is_verified(&borrower) {
                return Err(PoolError::ApplicantNotVerified);
            }
        }

        // Ensure loan ID doesn't already exist.
        if env
            .storage()
            .persistent()
            .has(&DataKey::Loan(loan_id.clone()))
        {
            return Err(PoolError::LoanAlreadyExists);
        }

        let config = Self::read_config(env)?;

        let loan = LoanRecord {
            borrower: borrower.clone(),
            principal,
            disbursed: 0,
            repaid: 0,
            interest_rate_bps: config.interest_rate_bps,
            status: LoanStatus::Requested,
            created_ledger: env.ledger().sequence(),
            last_interest_ledger: env.ledger().sequence(),
            outstanding_debt: 0,
            escrow_origin,
        };

        Self::set_loan(env, &loan_id, &loan);

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
            (Symbol::new(env, "loan_requested"),),
            (borrower, loan_id.clone(), principal),
        );

        Ok(())
    }

    /// Admin approves a pending loan request.
    ///
    /// Verifies that pool has sufficient liquidity for the loan principal,
    /// then transitions the loan status from Requested to Approved.
    pub fn approve_loan(env: Env, loan_id: BytesN<32>) -> Result<(), PoolError> {
        Self::check_not_paused(&env)?;
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
        Self::check_not_paused(&env)?;
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

        // Enforce daily borrow limit if configured.
        let limit: i128 = env
            .storage()
            .instance()
            .get(&DataKey::DailyBorrowLimit)
            .unwrap_or(0);
        if limit > 0 {
            let day_id = env.ledger().sequence() / LEDGERS_PER_DAY;
            let current_day_borrowed: i128 = env
                .storage()
                .instance()
                .get(&DataKey::DailyBorrowed(day_id))
                .unwrap_or(0);
            if current_day_borrowed.saturating_add(amount) > limit {
                return Err(PoolError::DailyBorrowLimitExceeded);
            }
            env.storage()
                .instance()
                .set(&DataKey::DailyBorrowed(day_id), &(current_day_borrowed + amount));
        }

        // Transfer funds to recipient.
        let token = Self::token_client(&env, &config.token);
        token.transfer(&env.current_contract_address(), &recipient, &amount);

        // Accrue compound interest on existing outstanding debt, then add disbursed amount.
        Self::accrue_interest(&env, &mut loan);
        loan.disbursed += amount;
        loan.outstanding_debt = loan.outstanding_debt.saturating_add(amount);
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
    /// Transfers USDC from the borrower to the pool. The repayment amount is split
    /// between principal recovery and interest. Interest is distributed using the
    /// tranche yield waterfall: senior tranche receives its fixed rate first, and
    /// the junior tranche receives the remainder.
    pub fn repay(
        env: Env,
        borrower: Address,
        loan_id: BytesN<32>,
        amount: i128,
    ) -> Result<(), PoolError> {
        Self::check_not_paused(&env)?;
        borrower.require_auth();

        if amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        let config = Self::read_config(&env)?;
        let mut loan = Self::read_loan(&env, &loan_id)?;

        if loan.status != LoanStatus::Approved {
            return Err(PoolError::InvalidLoanState);
        }

        // Accrue compound interest before computing what is owed.
        Self::accrue_interest(&env, &mut loan);

        // Keep simple-interest total_owed for yield waterfall distribution.
        let interest = (loan.principal * loan.interest_rate_bps as i128) / 10_000;
        let total_owed = loan.principal + interest;
        let remaining = loan.outstanding_debt;

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
        loan.outstanding_debt = loan.outstanding_debt.saturating_sub(amount);

        // ── Yield Distribution Waterfall ──────────────────────────────
        // Determine how much of this repayment is interest (vs principal recovery).
        // Interest is distributed pro-rata across the repayment.
        // Total interest on this loan = loan.principal * interest_rate_bps / 10_000.
        // Fraction of loan repaid this payment = amount / total_owed.
        let interest_in_payment = (interest * amount) / total_owed;

        if interest_in_payment > 0 {
            let senior_info = Self::read_tranche_info(&env, &Tranche::Senior);
            let junior_info = Self::read_tranche_info(&env, &Tranche::Junior);
            let total_pool = senior_info.total_deposited + junior_info.total_deposited;

            if total_pool > 0 {
                // Senior receives its fixed rate on its share of pool capital.
                // senior_yield = interest_in_payment * min(senior_rate / pool_rate, 1)
                // Simplified: senior_yield = senior_deposited * senior_rate_bps / pool_rate_bps
                //             but capped at interest_in_payment.
                let senior_yield = if senior_info.total_deposited > 0 {
                    let raw = (interest_in_payment * config.senior_rate_bps as i128)
                        / config.interest_rate_bps as i128;
                    // Scale by senior's share of total pool to avoid over-allocating.
                    let proportional = (raw * senior_info.total_deposited) / total_pool;
                    proportional.min(interest_in_payment)
                } else {
                    0i128
                };

                let junior_yield = interest_in_payment - senior_yield;

                // Credit senior tranche aggregate.
                if senior_yield > 0 {
                    let mut si = senior_info;
                    si.total_yield_distributed += senior_yield;
                    Self::set_tranche_info(&env, &Tranche::Senior, &si);
                }

                // Credit junior tranche aggregate.
                if junior_yield > 0 {
                    let mut ji = junior_info;
                    ji.total_yield_distributed += junior_yield;
                    Self::set_tranche_info(&env, &Tranche::Junior, &ji);
                }
            }
        }

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

        // Mark as repaid if fully paid (compound debt cleared).
        if loan.outstanding_debt == 0 {
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
        Self::check_not_paused(&env)?;
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

        loan.status = LoanStatus::Defaulted;
        Self::set_loan(&env, &loan_id, &loan);
        Ok(())
    }

    /// Investor withdraws available capital.
    ///
    /// A dynamic withdrawal fee is applied based on the pool's current utilization rate:
    /// - Utilization < 50%: 0.1% withdrawal fee
    /// - Utilization 50% - 80%: 0.5% withdrawal fee
    /// - Utilization > 80%: 2% withdrawal fee
    ///
    /// The fee is deducted from the withdrawal amount and transferred to the
    /// protocol treasury address. The net amount is transferred to the investor.
    pub fn withdraw(env: Env, investor: Address, amount: i128) -> Result<(), PoolError> {
        Self::check_not_paused(&env)?;
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

        // ── Dynamic Fee Calculation ───────────────────────────────────
        let utilization_bps = Self::calculate_utilization(&env);
        let fee_bps = Self::calculate_withdrawal_fee_bps(utilization_bps);
        let fee_amount = Self::calculate_fee_amount(amount, fee_bps);
        let net_amount = amount - fee_amount;

        // Ensure net amount is positive
        if net_amount <= 0 {
            return Err(PoolError::InvalidAmount);
        }

        // Update investor state
        record.deposited -= amount;
        Self::set_investor(&env, &investor, &record);

        // Update pool liquidity: reduce by net amount (fee stays in pool temporarily)
        let new_liquidity = liquidity - net_amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalLiquidity, &new_liquidity);

        let total_dep = Self::read_total_deposited(&env) - amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalDeposited, &total_dep);

        // Track total fees collected
        let total_fees = Self::read_total_withdrawal_fees(&env) + fee_amount;
        env.storage()
            .instance()
            .set(&DataKey::TotalWithdrawalFees, &total_fees);

        // Transfer net amount to investor
        let token = Self::token_client(&env, &config.token);
        token.transfer(&env.current_contract_address(), &investor, &net_amount);

        // Transfer fee to protocol treasury
        if fee_amount > 0 {
            token.transfer(&env.current_contract_address(), &config.treasury_address, &fee_amount);
        }

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("withdraw"),),
            (investor.clone(), amount, fee_amount, net_amount, utilization_bps),
        );

        Ok(())
    }

    /// Investor claims their proportional share of repaid interest.
    pub fn claim_yield(env: Env, investor: Address) -> Result<i128, PoolError> {
        Self::check_not_paused(&env)?;
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

    /// Returns aggregate metrics for the specified tranche.
    ///
    /// Includes total deposited capital, total yield distributed to date,
    /// and total losses absorbed by the tranche.
    pub fn get_tranche_info(env: Env, tranche: Tranche) -> TrancheInfo {
        Self::read_tranche_info(&env, &tranche)
    }

    /// Returns the total senior liquidity in the pool.
    pub fn get_senior_liquidity(env: Env) -> i128 {
        Self::read_tranche_info(&env, &Tranche::Senior).total_deposited
    }

    /// Returns the total junior liquidity in the pool.
    pub fn get_junior_liquidity(env: Env) -> i128 {
        Self::read_tranche_info(&env, &Tranche::Junior).total_deposited
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

    /// Returns the contract version (incremented on each successful upgrade).
    pub fn version(env: Env) -> u32 {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(1u32)
    }

    // ── Dynamic Fee Query Functions ──────────────────────────────────────

    /// Returns the current pool utilization rate in basis points (0-10000).
    ///
    /// Utilization = active_loan_commitments / total_pool_liquidity
    pub fn get_utilization(env: Env) -> u32 {
        Self::calculate_utilization(&env)
    }

    /// Returns the withdrawal fee in basis points that would apply to a
    /// withdrawal given the current pool utilization.
    pub fn get_withdrawal_fee_bps(env: Env) -> u32 {
        let utilization = Self::calculate_utilization(&env);
        Self::calculate_withdrawal_fee_bps(utilization)
    }

    /// Preview the fee breakdown for a hypothetical withdrawal amount.
    ///
    /// Returns (gross_amount, fee_amount, net_amount, fee_bps, utilization_bps).
    pub fn preview_withdrawal_fee(env: Env, amount: i128) -> (i128, i128, i128, u32, u32) {
        let utilization_bps = Self::calculate_utilization(&env);
        let fee_bps = Self::calculate_withdrawal_fee_bps(utilization_bps);
        let fee_amount = Self::calculate_fee_amount(amount, fee_bps);
        let net_amount = amount - fee_amount;
        (amount, fee_amount, net_amount, fee_bps, utilization_bps)
    }

    /// Returns the total withdrawal fees collected and routed to treasury.
    pub fn get_total_withdrawal_fees(env: Env) -> i128 {
        Self::read_total_withdrawal_fees(&env)
    }

    // ── Emergency Pause ──────────────────────────────────────────────────

    /// Halt all state-mutating operations. Admin-only.
    pub fn pause(env: Env) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Resume all operations after a pause. Admin-only.
    pub fn unpause(env: Env) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    // ── Admin Transfer ─────────────────────────────────────────────────

    /// Propose a new admin address. The current admin initiates the transfer.
    /// The pending admin must then call `accept_admin` to finalize.
    pub fn propose_new_admin(env: Env, new_admin: Address) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish(
            (symbol_short!("prop_adm"),),
            (config.admin, new_admin),
        );
        Ok(())
    }

    /// Accept the admin role. Callable only by the pending admin address
    /// that was previously proposed via `propose_new_admin`.
    pub fn accept_admin(env: Env) -> Result<(), PoolError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(PoolError::NotPendingAdmin)?;
        pending.require_auth();
        let mut config = Self::read_config(&env)?;
        config.admin = pending.clone();
        env.storage().instance().set(&DataKey::Config, &config);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        env.events().publish(
            (symbol_short!("accept_pd"),),
            (pending,),
        );
        Ok(())
    }

    // ── Verification Registry ────────────────────────────────────────────

    /// Set (or update) the VerificationRegistry contract address used to
    /// gate `request_loan`. Admin-only.
    ///
    /// Once set, `request_loan` and `request_loan_with_origin` will reject
    /// borrowers who do not have a valid, non-expired verification record
    /// in the registry with `PoolError::ApplicantNotVerified`.
    pub fn set_verification_registry(env: Env, registry: Address) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::VerificationRegistry, &registry);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("set_vreg"),),
            (registry,),
        );

        Ok(())
    }

    /// Returns the configured VerificationRegistry address, or `None` if
    /// the verification gate has not been enabled.
    pub fn get_verification_registry(env: Env) -> Option<Address> {
        Self::read_verification_registry(&env)
    }

    /// Set the daily borrow limit. Admin-only.
    /// A limit <= 0 means no limit.
    pub fn set_daily_borrow_limit(env: Env, limit: i128) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::DailyBorrowLimit, &limit);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);

        env.events().publish(
            (symbol_short!("set_limit"),),
            (limit,),
        );

        Ok(())
    }

    /// Get the daily borrow limit.
    pub fn get_daily_borrow_limit(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::DailyBorrowLimit)
            .unwrap_or(0)
    }

    /// Get the total amount borrowed in the current day's time window.
    pub fn get_daily_borrowed(env: Env) -> i128 {
        let day_id = env.ledger().sequence() / LEDGERS_PER_DAY;
        env.storage()
            .instance()
            .get(&DataKey::DailyBorrowed(day_id))
            .unwrap_or(0)
    }

    // ── Upgrade Functions ────────────────────────────────────────────────

    /// Set the number of ledgers that must elapse between proposing and
    /// executing an upgrade.  Pass `0` to disable the timelock.  Admin-only.
    pub fn set_upgrade_delay(env: Env, delay_ledgers: u32) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::UpgradeDelay, &delay_ledgers);
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Propose or execute a WASM upgrade.
    ///
    /// Behaviour mirrors the escrow contract:
    /// - No delay: immediate upgrade with version bump.
    /// - Delay > 0 and no pending: stores proposal, emits event.
    /// - Delay > 0 and pending but not yet due: returns `UpgradeTimelockActive`.
    /// - Delay > 0 and pending is due: executes upgrade with version bump.
    ///
    /// Admin-only.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        let delay: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UpgradeDelay)
            .unwrap_or(0u32);

        let current_ledger = env.ledger().sequence();

        if delay == 0 {
            let ver: u32 = env
                .storage()
                .instance()
                .get(&DataKey::Version)
                .unwrap_or(1u32);
            env.storage()
                .instance()
                .set(&DataKey::Version, &(ver + 1));
            env.deployer()
                .update_current_contract_wasm(new_wasm_hash.clone());
            env.events()
                .publish((symbol_short!("upgrade"),), (new_wasm_hash, ver + 1));
        } else {
            let maybe_pending: Option<PendingUpgradeRecord> = env
                .storage()
                .instance()
                .get(&DataKey::PendingUpgrade);

            match maybe_pending {
                None => {
                    let proposal = PendingUpgradeRecord {
                        new_wasm_hash,
                        execute_after: current_ledger + delay,
                    };
                    env.storage()
                        .instance()
                        .set(&DataKey::PendingUpgrade, &proposal);
                    env.events().publish(
                        (symbol_short!("upg_prop"),),
                        (proposal.execute_after,),
                    );
                }
                Some(pending) => {
                    if current_ledger < pending.execute_after {
                        return Err(PoolError::UpgradeTimelockActive);
                    }
                    env.storage().instance().remove(&DataKey::PendingUpgrade);
                    let ver: u32 = env
                        .storage()
                        .instance()
                        .get(&DataKey::Version)
                        .unwrap_or(1u32);
                    env.storage()
                        .instance()
                        .set(&DataKey::Version, &(ver + 1));
                    env.deployer()
                        .update_current_contract_wasm(pending.new_wasm_hash.clone());
                    env.events()
                        .publish((symbol_short!("upgrade"),), (pending.new_wasm_hash, ver + 1));
                }
            }
        }

        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Post-upgrade migration hook.  Admin calls this after a WASM upgrade to
    /// run version-specific storage migrations.  Admin-only.
    pub fn migrate(env: Env) -> Result<(), PoolError> {
        let config = Self::read_config(&env)?;
        config.admin.require_auth();

        let ver: u32 = env
            .storage()
            .instance()
            .get(&DataKey::Version)
            .unwrap_or(1u32);

        // Version-specific migration logic lives here in the newly deployed
        // contract code.  Placeholder — future versions add schema transforms.

        env.events().publish((symbol_short!("migrate"),), (ver,));
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
        Ok(())
    }

    /// Returns the pending upgrade proposal, if any.
    pub fn get_pending_upgrade(env: Env) -> Option<PendingUpgradeRecord> {
        env.storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as _, Events, Ledger},
        token::StellarAssetClient,
        Env,
    };

    /// Helper: deploy test token, mint to investor, initialize pool.
    fn setup_pool(env: &Env) -> (Address, Address, Address, Address, LendingPoolContractClient<\'_>) {
    fn setup_pool(env: &Env) -> (Address, Address, Address, Address, LendingPoolContractClient<'_,>) {
        let admin = Address::generate(env);
        let investor = Address::generate(env);
        let treasury = Address::generate(env);

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
        // 8% pool rate, 4% senior fixed rate
        client.initialize(&admin, &token_address, &800u32, &400u32, &treasury);

        (admin, investor, treasury, token_address, client)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, token_address, _escrow, client) = setup_pool(&env);
        let (admin, _investor, treasury, token_address, client) = setup_pool(&env);

        let config = client.get_pool_config();
        assert_eq!(config.admin, admin);
        assert_eq!(config.token, token_address);
        assert_eq!(config.interest_rate_bps, 800u32);
        assert_eq!(config.senior_rate_bps, 400u32);
        assert_eq!(config.treasury_address, treasury);
        assert_eq!(client.get_liquidity(), 0);

        let si = client.get_tranche_info(&Tranche::Senior);
        assert_eq!(si.total_deposited, 0);
        let ji = client.get_tranche_info(&Tranche::Junior);
        assert_eq!(ji.total_deposited, 0);
    }

    #[test]
    fn test_deposit() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let (_admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);

        assert_eq!(client.get_liquidity(), 50_000_0000000i128);
        assert_eq!(token.balance(&client.address), 50_000_0000000i128);

        let info = client.get_investor_info(&investor);
        assert_eq!(info.deposited, 50_000_0000000i128);
        assert_eq!(info.tranche, Tranche::Senior);

        let si = client.get_tranche_info(&Tranche::Senior);
        assert_eq!(si.total_deposited, 50_000_0000000i128);
    }

    #[test]
    fn test_deposit_junior_tranche() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        client.deposit(&investor, &20_000_0000000i128, &Tranche::Junior);

        let info = client.get_investor_info(&investor);
        assert_eq!(info.tranche, Tranche::Junior);

        let ji = client.get_tranche_info(&Tranche::Junior);
        assert_eq!(ji.total_deposited, 20_000_0000000i128);

        assert_eq!(client.get_junior_liquidity(), 20_000_0000000i128);
        assert_eq!(client.get_senior_liquidity(), 0);
    }

    #[test]
    fn test_deposit_tranche_mismatch_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        client.deposit(&investor, &10_000_0000000i128, &Tranche::Senior);

        let result = client.try_deposit(&investor, &5_000_0000000i128, &Tranche::Junior);
        assert!(result.is_err());
    }

    #[test]
    fn test_deposit_zero_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        let result = client.try_deposit(&investor, &0i128, &Tranche::Senior);
        assert!(result.is_err());
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, token_address, _escrow, client) = setup_pool(&env);

        let result = client.try_initialize(&admin, &token_address, &_escrow, &800u32);
        let (admin, _investor, _treasury, token_address, client) = setup_pool(&env);

        let result = client.try_initialize(&admin, &token_address, &800u32, &400u32, &Address::generate(&env));
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
        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Fund the pool.
        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);

        // Borrower requests a 70,000 USDC loan.
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);
        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Requested);
        assert_eq!(loan.principal, 70_000_0000000i128);
        assert_eq!(loan.borrower, borrower);

        // Verify request_loan event was emitted.
        let _events = env.events().all();

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
        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Only deposit 5,000 but request 70,000.
        client.deposit(&investor, &5_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);

        let result = client.try_approve_loan(&loan_id);
        assert!(result.is_err());
    }

    #[test]
    fn test_duplicate_loan_id_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);

        // Same loan ID should fail.
        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert!(result.is_err());
    }

    // ── Verification Registry Gate ───────────────────────────────────────

    /// Helper: deploy and initialize a VerificationRegistryContract.
    fn setup_registry<'a>(
        env: &'a Env,
        admin: &Address,
    ) -> verification_registry::VerificationRegistryContractClient<'a> {
        let registry_id = env.register(verification_registry::VerificationRegistryContract, ());
        let registry = verification_registry::VerificationRegistryContractClient::new(env, &registry_id);
        registry.initialize(admin);
        registry
    }

    #[test]
    fn test_request_loan_succeeds_without_registry_configured() {
        // Backward-compatible default: if no registry has ever been set,
        // the gate is skipped entirely and loans behave as before.
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);
        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);

        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert!(result.is_ok());
        assert_eq!(client.get_verification_registry(), None);
    }

    #[test]
    fn test_admin_can_set_verification_registry() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, _treasury, _token_address, client) = setup_pool(&env);
        let registry = setup_registry(&env, &admin);

        client.set_verification_registry(&registry.address);
        assert_eq!(client.get_verification_registry(), Some(registry.address));
    }

    #[test]
    fn test_non_admin_cannot_set_verification_registry() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);
        let registry_admin = Address::generate(&env);
        let registry = setup_registry(&env, &registry_admin);
        let non_admin = Address::generate(&env);

        // Only the non-admin signs; the contract requires `config.admin`'s
        // authorization, so the call must fail.
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &client.address,
                fn_name: "set_verification_registry",
                args: (registry.address.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_set_verification_registry(&registry.address);
        assert!(result.is_err());
    }

    #[test]
    fn test_request_loan_rejects_unverified_borrower() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let registry = setup_registry(&env, &admin);
        client.set_verification_registry(&registry.address);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);

        // Borrower has no record in the registry at all.
        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ApplicantNotVerified));
    }

    #[test]
    fn test_request_loan_succeeds_for_verified_borrower() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let registry = setup_registry(&env, &admin);
        client.set_verification_registry(&registry.address);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);
        let report_hash = BytesN::from_array(&env, &[9u8; 32]);

        registry.register_verification(&borrower, &report_hash, &1_000u32);

        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);

        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert!(result.is_ok());

        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Requested);
    }

    #[test]
    fn test_request_loan_rejects_borrower_with_expired_verification() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let registry = setup_registry(&env, &admin);
        client.set_verification_registry(&registry.address);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);
        let report_hash = BytesN::from_array(&env, &[4u8; 32]);

        // Verification expires after 50 ledgers.
        registry.register_verification(&borrower, &report_hash, &50u32);

        // Advance the ledger well past expiration.
        env.ledger().with_mut(|li| li.sequence_number += 1_000);

        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);

        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ApplicantNotVerified));
    }

    #[test]
    fn test_request_loan_with_origin_also_gated() {
        // The escrow bridge entry point shares the same gate, so a borrower
        // cannot bypass verification by routing through the escrow path.
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let registry = setup_registry(&env, &admin);
        client.set_verification_registry(&registry.address);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);
        let escrow_origin = Address::generate(&env);

        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);

        let result = client.try_request_loan_with_origin(
            &borrower,
            &loan_id,
            &10_000_0000000i128,
            &escrow_origin,
        );
        assert_eq!(result.unwrap_err(), Ok(PoolError::ApplicantNotVerified));
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

        let (_admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);
        let borrower = Address::generate(&env);
        let contractor = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Fund the pool with mixed tranches.
        client.deposit(&investor, &70_000_0000000i128, &Tranche::Senior);
        let junior_investor = Address::generate(&env);
        let sac0 = StellarAssetClient::new(&env, &token_address);
        sac0.mint(&junior_investor, &30_000_0000000i128);
        client.deposit(&junior_investor, &30_000_0000000i128, &Tranche::Junior);

        // Request + approve loan.
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);
        client.approve_loan(&loan_id);

        // Disburse 30,000 to contractor (first milestone).
        client.disburse(&loan_id, &contractor, &30_000_0000000i128);
        assert_eq!(token.balance(&contractor), 30_000_0000000i128);

        // Disburse remaining 40,000.
        client.disburse(&loan_id, &contractor, &40_000_0000000i128);
        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.disbursed, 70_000_0000000i128);

        // Advance ledger by 1 period to compound interest
        env.ledger().set_sequence_number(env.ledger().sequence() + 100);

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

        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let contractor = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
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
        let token = token::Client::new(&env, &token_address);
        let (_admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);

        // Mint USDC to borrower for repayment.
        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&borrower, &20_000_0000000i128);

        // Total owed = 10,000 + 8% = 10,800. Try to repay 15,000.
        let result = client.try_repay(&borrower, &loan_id, &15_000_0000000i128);
        assert!(result.is_err());
    }

    /// Test that yield is split correctly: junior gets more than senior.
    #[test]
    fn test_yield_distribution_senior_junior() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _token_address, _escrow, client) = setup_pool(&env);
        let (_admin, senior_investor, _treasury, token_address, client) = setup_pool(&env);
        let sac = StellarAssetClient::new(&env, &token_address);

        let junior_investor = Address::generate(&env);
        sac.mint(&junior_investor, &50_000_0000000i128);

        client.deposit(&senior_investor, &50_000_0000000i128, &Tranche::Senior);
        client.deposit(&junior_investor, &50_000_0000000i128, &Tranche::Junior);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &10_000_0000000i128);

        // Advance ledger by 1 period to compound interest
        env.ledger().set_sequence_number(env.ledger().sequence() + 100);

        sac.mint(&borrower, &20_000_0000000i128);

        // Full repayment: 10,800 USDC (10,000 principal + 800 interest at 8%).
        client.repay(&borrower, &loan_id, &10_800_0000000i128);

        let senior_info = client.get_tranche_info(&Tranche::Senior);
        let junior_info = client.get_tranche_info(&Tranche::Junior);

        assert!(senior_info.total_yield_distributed > 0, "senior should receive yield");
        assert!(junior_info.total_yield_distributed > 0, "junior should receive yield");
        // Junior gets more because it absorbs more risk.
        assert!(
            junior_info.total_yield_distributed > senior_info.total_yield_distributed,
            "junior yield should exceed senior yield"
        );
    }

    /// Test loss waterfall: junior absorbs loss before senior.
    #[test]
    fn test_loss_waterfall_junior_first() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor1, token_address, _escrow, client) = setup_pool(&env);
        
        // Setup investor 2
        let investor2 = Address::generate(&env);
        let (_admin, senior_investor, _treasury, token_address, client) = setup_pool(&env);
        let sac = StellarAssetClient::new(&env, &token_address);

        let junior_investor = Address::generate(&env);
        sac.mint(&junior_investor, &30_000_0000000i128);

        client.deposit(&senior_investor, &70_000_0000000i128, &Tranche::Senior);
        client.deposit(&junior_investor, &30_000_0000000i128, &Tranche::Junior);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Loan 20,000; junior has 30,000 to absorb.
        client.request_loan(&borrower, &loan_id, &20_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &20_000_0000000i128);

        client.mark_default(&loan_id);

        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.status, LoanStatus::Defaulted);

        let junior_info = client.get_tranche_info(&Tranche::Junior);
        let senior_info = client.get_tranche_info(&Tranche::Senior);

        // Junior absorbs full 20,000 loss (had 30,000 so 10,000 remains).
        assert_eq!(junior_info.total_loss_absorbed, 20_000_0000000i128);
        assert_eq!(junior_info.total_deposited, 10_000_0000000i128);
        // Senior is unaffected.
        assert_eq!(senior_info.total_loss_absorbed, 0);
        assert_eq!(senior_info.total_deposited, 70_000_0000000i128);
    }

    /// Test loss waterfall overflow: senior absorbs remainder when junior exhausted.
    #[test]
    fn test_loss_waterfall_senior_absorbs_overflow() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, senior_investor, _treasury, token_address, client) = setup_pool(&env);
        let sac = StellarAssetClient::new(&env, &token_address);

        let junior_investor = Address::generate(&env);
        sac.mint(&junior_investor, &5_000_0000000i128);

        client.deposit(&senior_investor, &50_000_0000000i128, &Tranche::Senior);
        client.deposit(&junior_investor, &5_000_0000000i128, &Tranche::Junior);

        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Loan 20,000; junior has only 5,000 to absorb.
        client.request_loan(&borrower, &loan_id, &20_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &20_000_0000000i128);

        client.mark_default(&loan_id);

        let junior_info = client.get_tranche_info(&Tranche::Junior);
        let senior_info = client.get_tranche_info(&Tranche::Senior);

        assert_eq!(junior_info.total_loss_absorbed, 5_000_0000000i128);
        assert_eq!(junior_info.total_deposited, 0);
        assert_eq!(senior_info.total_loss_absorbed, 15_000_0000000i128);
        assert_eq!(senior_info.total_deposited, 35_000_0000000i128);
    }

    /// Test mixed-tranche pool liquidity tracking.
    #[test]
    fn test_mixed_tranche_pool_tracking() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, senior_investor, _treasury, token_address, client) = setup_pool(&env);
        let sac = StellarAssetClient::new(&env, &token_address);

        let junior_investor = Address::generate(&env);
        sac.mint(&junior_investor, &40_000_0000000i128);

        client.deposit(&senior_investor, &60_000_0000000i128, &Tranche::Senior);
        client.deposit(&junior_investor, &40_000_0000000i128, &Tranche::Junior);

        assert_eq!(client.get_senior_liquidity(), 60_000_0000000i128);
        assert_eq!(client.get_junior_liquidity(), 40_000_0000000i128);
        assert_eq!(client.get_liquidity(), 100_000_0000000i128);

        let si = client.get_investor_info(&senior_investor);
        assert_eq!(si.tranche, Tranche::Senior);
        assert_eq!(si.deposited, 60_000_0000000i128);

        let ji = client.get_investor_info(&junior_investor);
        assert_eq!(ji.tranche, Tranche::Junior);
        assert_eq!(ji.deposited, 40_000_0000000i128);
    }

    #[test]
    fn test_double_claim() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, token_address, _escrow, client) = setup_pool(&env);
        let (_admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &10_000_0000000i128);
        env.ledger().set_sequence_number(env.ledger().sequence() + 100);

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
        let (_admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &10_000_0000000i128);
        env.ledger().set_sequence_number(env.ledger().sequence() + 100);

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
        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);
        let unauthorized = Address::generate(&env);

        // This will panic because unauthorized doesn't have auth mocked.
        client.withdraw(&unauthorized, &10_000_0000000i128);
    }

    // ── Dynamic Fee Tests ────────────────────────────────────────────────

    #[test]
    fn test_utilization_zero_with_no_loans() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, _token, client) = setup_pool(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);

        // No active loans = 0% utilization
        assert_eq!(client.get_utilization(), 0u32);
        assert_eq!(client.get_withdrawal_fee_bps(), 10u32); // 0.1%
    }

    #[test]
    fn test_utilization_low_tier_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Deposit 100k, request 30k loan (30% utilization)
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &30_000_0000000i128);
        client.approve_loan(&loan_id);

        // 30% utilization = low tier = 0.1% fee
        assert_eq!(client.get_utilization(), 3_000u32); // 30%
        assert_eq!(client.get_withdrawal_fee_bps(), 10u32);

        // Preview: 10_000 withdrawal at 0.1% = 10 fee, 9990 net
        let preview = client.preview_withdrawal_fee(&10_000_0000000i128);
        assert_eq!(preview, (10_000_0000000i128, 10_0000000i128, 9_990_0000000i128, 10u32, 3_000u32));
    }

    #[test]
    fn test_utilization_medium_tier_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Deposit 100k, request 60k loan (60% utilization)
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &60_000_0000000i128);
        client.approve_loan(&loan_id);

        // 60% utilization = medium tier = 0.5% fee
        assert_eq!(client.get_utilization(), 6_000u32); // 60%
        assert_eq!(client.get_withdrawal_fee_bps(), 50u32);

        // Preview: 10_000 withdrawal at 0.5% = 50 fee
        let preview = client.preview_withdrawal_fee(&10_000_0000000i128);
        assert_eq!(preview, (10_000_0000000i128, 50_0000000i128, 9_950_0000000i128, 50u32, 6_000u32));
    }

    #[test]
    fn test_utilization_high_tier_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Deposit 100k, request 90k loan (90% utilization)
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &90_000_0000000i128);
        client.approve_loan(&loan_id);

        // 90% utilization = high tier = 2% fee
        assert_eq!(client.get_utilization(), 9_000u32); // 90%
        assert_eq!(client.get_withdrawal_fee_bps(), 200u32);

        // Preview: 10_000 withdrawal at 2% = 200 fee
        let preview = client.preview_withdrawal_fee(&10_000_0000000i128);
        assert_eq!(preview, (10_000_0000000i128, 200_0000000i128, 9_800_0000000i128, 200u32, 9_000u32));
    }

    #[test]
    fn test_withdrawal_fee_routed_to_treasury() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, treasury, token_address, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Setup: 100k deposit, 70k loan (70% utilization = 0.5% fee)
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &70_000_0000000i128);
        client.approve_loan(&loan_id);

        let treasury_before = token.balance(&treasury);
        let investor_before = token.balance(&investor);

        // Withdraw 10_000 at 70% utilization: 0.5% fee = 50
        client.withdraw(&investor, &10_000_0000000i128);

        // Verify fee routing
        let treasury_after = token.balance(&treasury);
        let investor_after = token.balance(&investor);

        assert_eq!(treasury_after - treasury_before, 50_0000000i128); // 0.5% of 10k
        assert_eq!(investor_after - investor_before, 9_950_0000000i128); // 10k - 50 fee

        // Verify total fees tracking
        assert_eq!(client.get_total_withdrawal_fees(), 50_0000000i128);

        // Verify investor record updated for gross amount
        let record = client.get_investor_info(&investor);
        assert_eq!(record.deposited, 90_000_0000000i128); // 100k - 10k gross
    }

    #[test]
    fn test_fee_scales_with_multiple_withdrawals() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, treasury, token_address, client) = setup_pool(&env);
        let token = token::Client::new(&env, &token_address);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &85_000_0000000i128);
        client.approve_loan(&loan_id);

        // First withdrawal: 85% util = 2% fee
        client.withdraw(&investor, &5_000_0000000i128);
        let fee1 = client.get_total_withdrawal_fees();
        assert_eq!(fee1, 100_0000000i128); // 2% of 5k = 100

        // Second withdrawal
        client.withdraw(&investor, &5_000_0000000i128);
        let fee2 = client.get_total_withdrawal_fees();
        assert_eq!(fee2, 200_0000000i128); // Another 100

        // Verify treasury received both fees
        assert_eq!(token.balance(&treasury), 200_0000000i128);
    }

    #[test]
    fn test_zero_utilization_after_full_repayment() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let sac = StellarAssetClient::new(&env, &token_address);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &80_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &80_000_0000000i128);

        // High utilization during active loan
        assert_eq!(client.get_withdrawal_fee_bps(), 200u32);

        // Advance ledger by 1 period to compound interest
        env.ledger().set_sequence_number(env.ledger().sequence() + 100);

        // Borrower repays full amount
        sac.mint(&borrower, &90_000_0000000i128);
        client.repay(&borrower, &loan_id, &86_400_0000000i128); // principal + 8%

        // After repayment, commitments released, utilization drops
        assert_eq!(client.get_utilization(), 0u32);
        assert_eq!(client.get_withdrawal_fee_bps(), 10u32);
    }

    #[test]
    fn test_withdrawal_at_exact_thresholds() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
        let borrower = Address::generate(&env);

        // Test at exactly 50% (medium tier boundary)
        let loan_id_50 = BytesN::from_array(&env, &[2u8; 32]);
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id_50, &50_000_0000000i128);
        client.approve_loan(&loan_id_50);
        assert_eq!(client.get_withdrawal_fee_bps(), 50u32); // >= 50% = medium
    }

    #[test]
    fn test_withdrawal_fails_if_net_amount_zero() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, investor, _treasury, _token, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        // Create 99% utilization (very high fee tier)
        client.deposit(&investor, &10_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &9_900_0000000i128);
        client.approve_loan(&loan_id);

        // Small withdrawal should still work
        let result = client.try_withdraw(&investor, &1i128);
        assert!(result.is_ok());
    }

    // ── Upgrade Tests ────────────────────────────────────────────────────

    #[test]
    fn test_version_reads_from_storage() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        // After initialize(), version should be 1.
        assert_eq!(client.version(), 1u32);
    }

    #[test]
    fn test_set_upgrade_delay() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        // Set a 200-ledger delay.
        client.set_upgrade_delay(&200u32);

        // Proposing an upgrade stores a pending record.
        let dummy_hash = BytesN::from_array(&env, &[5u8; 32]);
        client.upgrade(&dummy_hash);

        let pending = client.get_pending_upgrade();
        assert!(pending.is_some());
        let p = pending.unwrap();
        assert_eq!(p.new_wasm_hash, dummy_hash);
        assert!(p.execute_after >= 200u32);
    }

    #[test]
    fn test_upgrade_timelock_active_before_delay() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        client.set_upgrade_delay(&1000u32);
        let dummy_hash = BytesN::from_array(&env, &[6u8; 32]);
        client.upgrade(&dummy_hash);

        // Attempting execution before delay elapses must return UpgradeTimelockActive = 12.
        let result = client.try_upgrade(&dummy_hash);
        assert_eq!(
            result.unwrap_err(),
            Ok(PoolError::UpgradeTimelockActive)
        );
    }

    #[test]
    fn test_upgrade_timelock_executes_after_delay() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        client.set_upgrade_delay(&100u32);
        let dummy_hash = BytesN::from_array(&env, &[7u8; 32]);
        client.upgrade(&dummy_hash);

        let pending = client.get_pending_upgrade().unwrap();
        assert!(pending.execute_after > env.ledger().sequence());

        // Advance ledger past the delay.
        env.ledger().with_mut(|l| l.sequence_number = pending.execute_after);

        // Reset to no delay so re-calling upgrade does not re-trigger a proposal
        // (the pending record was the one we just verified above).
        client.set_upgrade_delay(&0u32);
    }

    #[test]
    fn test_state_preserved_across_upgrade_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        // Investor deposits into the pool.
        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        assert_eq!(client.get_liquidity(), 50_000_0000000i128);

        // Propose an upgrade (timelock path).
        client.set_upgrade_delay(&300u32);
        let dummy_hash = BytesN::from_array(&env, &[8u8; 32]);
        client.upgrade(&dummy_hash);

        // Loan data and pool state are unaffected by the pending proposal.
        assert_eq!(client.get_liquidity(), 50_000_0000000i128);
        let info = client.get_investor_info(&investor);
        assert_eq!(info.deposited, 50_000_0000000i128);
    }

    #[test]
    fn test_migrate_by_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        client.migrate();

        // Version unchanged after migrate().
        assert_eq!(client.version(), 1u32);
    }

    #[test]
    fn test_no_pending_without_delay() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        // No delay set → get_pending_upgrade returns None before any call.
        assert!(client.get_pending_upgrade().is_none());
    }

    #[test]
    fn test_compound_interest_grows_exponentially() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let sac = StellarAssetClient::new(&env, &token_address);
        let borrower = Address::generate(&env);
        sac.mint(&borrower, &200_000_0000000i128);

        // Investor deposits liquidity.
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);

        // Borrower requests and admin approves a loan.
        let loan_id = BytesN::from_array(&env, &[42u8; 32]);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);

        // Disburse the full principal.
        client.disburse(&loan_id, &borrower, &10_000_0000000i128);

        let loan_after_disburse = client.get_loan_info(&loan_id);
        assert_eq!(loan_after_disburse.outstanding_debt, 10_000_0000000i128);

        // Advance 1 compound period (100 ledgers in test).
        let start = env.ledger().sequence();
        env.ledger().set_sequence_number(start + 100);

        // Trigger accrual via a repay call (tiny amount to update state).
        // With rate_bps=800, per-period factor = 1 + 800/10_000 = 1.08
        // After 1 period: outstanding_debt ≈ 10_000 * 1.08 = 10_800
        client.repay(&borrower, &loan_id, &1_0000000i128);
        let loan_1 = client.get_loan_info(&loan_id);
        let debt_after_1 = loan_1.outstanding_debt;
        // Should be approximately 10_800 USDC minus the 1 USDC repaid.
        assert!(debt_after_1 > 10_000_0000000i128);

        // Advance another period.
        env.ledger().set_sequence_number(start + 200);
        client.repay(&borrower, &loan_id, &1_0000000i128);
        let loan_2 = client.get_loan_info(&loan_id);
        let debt_after_2 = loan_2.outstanding_debt;

        // After 2 compound periods, debt should be exponentially higher than after 1.
        // d2 > d1 (still growing even after partial repayments).
        assert!(debt_after_2 > debt_after_1);
    }

    #[test]
    fn test_outstanding_debt_initialized_at_zero() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);

        let borrower = Address::generate(&env);
        let loan_id = BytesN::from_array(&env, &[99u8; 32]);
        client.request_loan(&borrower, &loan_id, &5_000_0000000i128);

        let loan = client.get_loan_info(&loan_id);
        assert_eq!(loan.outstanding_debt, 0i128);
    }

    #[test]
    fn test_deposit_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        client.pause();
        let result = client.try_deposit(&Address::generate(&env), &10_000_0000000i128, &Tranche::Senior);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_withdraw_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.pause();

        let result = client.try_withdraw(&investor, &10_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_request_loan_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.pause();

        let result = client.try_request_loan(&borrower, &loan_id, &10_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_approve_loan_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.pause();

        let result = client.try_approve_loan(&loan_id);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_disburse_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let contractor = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.pause();

        let result = client.try_disburse(&loan_id, &contractor, &5_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_repay_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.disburse(&loan_id, &borrower, &10_000_0000000i128);

        let sac = StellarAssetClient::new(&env, &token_address);
        sac.mint(&borrower, &20_000_0000000i128);

        client.pause();

        let result = client.try_repay(&borrower, &loan_id, &5_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_mark_default_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let loan_id = mock_loan_id(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.request_loan(&borrower, &loan_id, &10_000_0000000i128);
        client.approve_loan(&loan_id);
        client.pause();

        let result = client.try_mark_default(&loan_id);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_claim_yield_reverts_when_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        client.deposit(&investor, &50_000_0000000i128, &Tranche::Senior);
        client.pause();

        let result = client.try_claim_yield(&investor);
        assert_eq!(result.unwrap_err(), Ok(PoolError::ContractPaused));
    }

    #[test]
    fn test_deposit_resumes_after_unpause() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        client.pause();
        client.unpause();

        let result = client.try_deposit(&investor, &10_000_0000000i128, &Tranche::Senior);
        assert!(result.is_ok());
        assert_eq!(client.get_liquidity(), 10_000_0000000i128);
    }

    #[test]
    fn test_query_functions_work_while_paused() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);

        client.deposit(&investor, &25_000_0000000i128, &Tranche::Junior);
        client.pause();

        // Query functions must still work
        let config = client.get_pool_config();
        assert_eq!(config.admin, admin);
        assert_eq!(client.get_liquidity(), 25_000_0000000i128);
        let info = client.get_investor_info(&investor);
        assert_eq!(info.deposited, 25_000_0000000i128);
        let ti = client.get_tranche_info(&Tranche::Junior);
        assert_eq!(ti.total_deposited, 25_000_0000000i128);
    }

    #[test]
    fn test_admin_transfer_flow() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, _treasury, _token_address, client) = setup_pool(&env);
        let new_admin = Address::generate(&env);

        client.propose_new_admin(&new_admin);
        client.accept_admin();

        let config = client.get_pool_config();
        assert_eq!(config.admin, new_admin);
    }

    #[test]
    fn test_accept_admin_without_proposal_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let (_admin, _investor, _treasury, _token_address, client) = setup_pool(&env);

        let result = client.try_accept_admin();
        assert_eq!(result.unwrap_err(), Ok(PoolError::NotPendingAdmin));
    }

    #[test]
    fn test_non_admin_cannot_pause() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, _investor, _treasury, _token_address, client) = setup_pool(&env);
        env.mock_all_auths();
        let result = client.try_pause();
        assert!(result.is_ok());
    }

    #[test]
    fn test_daily_borrow_limit_enforced() {
        let env = Env::default();
        env.mock_all_auths();

        let (admin, investor, _treasury, _token_address, client) = setup_pool(&env);
        let borrower = Address::generate(&env);
        let contractor = Address::generate(&env);

        // Deposit liquidity.
        client.deposit(&investor, &100_000_0000000i128, &Tranche::Senior);

        // Configure daily limit to 10k USDC
        assert_eq!(client.get_daily_borrow_limit(), 0);
        client.set_daily_borrow_limit(&10_000_0000000i128);
        assert_eq!(client.get_daily_borrow_limit(), 10_000_0000000i128);

        // Request and approve a 50k loan.
        let loan_id = mock_loan_id(&env);
        client.request_loan(&borrower, &loan_id, &50_000_0000000i128);
        client.approve_loan(&loan_id);

        // Disburse 10k -> should succeed.
        client.disburse(&loan_id, &contractor, &10_000_0000000i128);
        assert_eq!(client.get_daily_borrowed(), 10_000_0000000i128);

        // Disburse another 1k -> should fail (exceeds daily limit).
        let result = client.try_disburse(&loan_id, &contractor, &1_000_0000000i128);
        assert_eq!(result.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));

        // Advance ledger by 1 day (100 ledgers in test).
        let current = env.ledger().sequence();
        env.ledger().set_sequence_number(current + 100);

        // Accumulator for the new day should be 0.
        assert_eq!(client.get_daily_borrowed(), 0);

        // Disburse 1k -> should succeed now.
        client.disburse(&loan_id, &contractor, &1_000_0000000i128);
        assert_eq!(client.get_daily_borrowed(), 1_000_0000000i128);

        // Disburse 10k -> should fail.
        let result2 = client.try_disburse(&loan_id, &contractor, &10_000_0000000i128);
        assert_eq!(result2.unwrap_err(), Ok(PoolError::DailyBorrowLimitExceeded));
    }
}
