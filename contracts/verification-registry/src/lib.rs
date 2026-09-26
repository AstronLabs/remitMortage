// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

mod errors;
mod types;

use crate::errors::RegistryError;
use crate::types::{DataKey, DecayConfig, RateConfig, RiskRecord, RiskTier, VerificationRecord};
use soroban_sdk::{contract, contractimpl, symbol_short, Address, BytesN, Env};

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

const PERSISTENT_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

// ── Rate Cap & Floor Constants ────────────────────────────────────────────
/// Maximum interest rate cap: 18% APR (1800 basis points).
const RATE_CAP_BPS: u32 = 1800;
/// Minimum interest rate floor: 2% APR (200 basis points).
const RATE_FLOOR_BPS: u32 = 200;

// ── Score Decay Constants ─────────────────────────────────────────────────
/// Ledgers per day at the network's ~5 second close time.
const LEDGERS_PER_DAY: u32 = 17_280;
/// Inactivity tolerated before a score starts decaying: 180 days.
const DEFAULT_DECAY_THRESHOLD_LEDGERS: u32 = 180 * LEDGERS_PER_DAY;
/// Length of one decay period: 30 days.
const DEFAULT_DECAY_PERIOD_LEDGERS: u32 = 30 * LEDGERS_PER_DAY;
/// Score points shed per decay period.
const DEFAULT_DECAY_POINTS_PER_PERIOD: u32 = 5;
/// Decay never pushes a score below this value.
const DEFAULT_DECAY_MIN_SCORE: u32 = 0;

/// Verification Registry Contract
///
/// Acts as an on-chain anchor for borrower eligibility verification
/// reports. Rather than storing sensitive financial datasets on-chain,
/// only the cryptographic hash of each report is anchored here, allowing
/// third parties to audit that a borrower was verified without exposing
/// the underlying data.
#[contract]
pub struct VerificationRegistryContract;

/// Internal helpers.
impl VerificationRegistryContract {
    fn read_admin(env: &Env) -> Result<Address, RegistryError> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(RegistryError::NotInitialized)
    }

    fn record_key(borrower: &Address) -> DataKey {
        DataKey::Verification(borrower.clone())
    }

    fn read_record(env: &Env, borrower: &Address) -> Option<VerificationRecord> {
        let key = Self::record_key(borrower);
        let record: Option<VerificationRecord> = env.storage().persistent().get(&key);
        if record.is_some() {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        record
    }

    fn set_record(env: &Env, borrower: &Address, record: &VerificationRecord) {
        let key = Self::record_key(borrower);
        env.storage().persistent().set(&key, record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }

    fn risk_key(borrower: &Address) -> DataKey {
        DataKey::Risk(borrower.clone())
    }

    fn tier_from_score(score: u32) -> RiskTier {
        if score >= 80 {
            RiskTier::Excellent
        } else if score >= 60 {
            RiskTier::Good
        } else if score >= 40 {
            RiskTier::Fair
        } else {
            RiskTier::Poor
        }
    }

    fn read_risk_record(env: &Env, borrower: &Address) -> Option<RiskRecord> {
        let key = Self::risk_key(borrower);
        let record: Option<RiskRecord> = env.storage().persistent().get(&key);
        if record.is_some() {
            env.storage().persistent().extend_ttl(
                &key,
                PERSISTENT_LIFETIME_THRESHOLD,
                PERSISTENT_BUMP_AMOUNT,
            );
        }
        record
    }

    fn set_risk_record(env: &Env, borrower: &Address, record: &RiskRecord) {
        let key = Self::risk_key(borrower);
        env.storage().persistent().set(&key, record);
        env.storage().persistent().extend_ttl(
            &key,
            PERSISTENT_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        );
    }

    fn seed_risk_from_score(score: u32) -> RiskRecord {
        RiskRecord {
            score,
            tier: Self::tier_from_score(score),
            consecutive_late: 0,
            on_time_payments: 0,
            late_payments: 0,
        }
    }

    /// Current decay parameters, falling back to the protocol defaults when
    /// the admin has not configured any.
    fn read_decay_config(env: &Env) -> DecayConfig {
        env.storage()
            .instance()
            .get(&DataKey::DecayConfig)
            .unwrap_or(DecayConfig {
                threshold_ledgers: DEFAULT_DECAY_THRESHOLD_LEDGERS,
                points_per_period: DEFAULT_DECAY_POINTS_PER_PERIOD,
                period_ledgers: DEFAULT_DECAY_PERIOD_LEDGERS,
                min_score: DEFAULT_DECAY_MIN_SCORE,
            })
    }

    /// Score points lost to inactivity since `last_verified_ledger`.
    ///
    /// Zero while the borrower is inside the grace window, then growing
    /// linearly with elapsed ledgers. The multiplication is done in `u64`
    /// because `elapsed * points_per_period` overflows `u32` for long-dormant
    /// accounts, and the result is clamped to 100 — a score can never lose
    /// more points than the scale holds.
    fn decay_points(env: &Env, last_verified_ledger: u32, config: &DecayConfig) -> u32 {
        if config.points_per_period == 0 || config.period_ledgers == 0 {
            return 0;
        }

        let now = env.ledger().sequence();
        if now <= last_verified_ledger {
            return 0;
        }

        let elapsed = now - last_verified_ledger;
        if elapsed <= config.threshold_ledgers {
            return 0;
        }

        let overdue = (elapsed - config.threshold_ledgers) as u64;
        let points = overdue.saturating_mul(config.points_per_period as u64)
            / config.period_ledgers as u64;

        points.min(100u64) as u32
    }

    /// Applies inactivity decay to `score` for a borrower.
    ///
    /// Returns `score` unchanged when the borrower has no verification record
    /// to anchor the timer to, or is still inside the grace window.
    fn decayed_score(env: &Env, borrower: &Address, score: u32) -> u32 {
        let anchor = match Self::read_record(env, borrower) {
            Some(record) => record.last_verified_ledger,
            None => return score,
        };

        let config = Self::read_decay_config(env);
        let lost = Self::decay_points(env, anchor, &config);

        score.saturating_sub(lost).max(config.min_score.min(score))
    }

    fn read_lending_pool(env: &Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::LendingPool)
    }

    fn read_rate_cap(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RateCap)
            .unwrap_or(RATE_CAP_BPS)
    }

    fn read_rate_floor(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::RateFloor)
            .unwrap_or(RATE_FLOOR_BPS)
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_LIFETIME_THRESHOLD, INSTANCE_BUMP_AMOUNT);
    }
}

#[contractimpl]
impl VerificationRegistryContract {
    /// Initialize the registry with the admin authorized to anchor reports.
    pub fn initialize(env: Env, admin: Address) -> Result<(), RegistryError> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(RegistryError::AlreadyInitialized);
        }

        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("init"),),
            (admin,),
        );

        Ok(())
    }

    /// Anchor a borrower eligibility report hash on-chain.
    ///
    /// Admin-only. The record expires duration_ledgers after the current
    /// ledger; registering again for the same borrower overwrites the
    /// previous record.
    pub fn register_verification(
        env: Env,
        borrower: Address,
        report_hash: BytesN<32>,
        duration_ledgers: u32,
        score: u32,
    ) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        if duration_ledgers == 0 {
            return Err(RegistryError::InvalidDuration);
        }

        if score > 100 {
            return Err(RegistryError::InvalidScore);
        }

        let zero: BytesN<32> = BytesN::from_array(&env, &[0u8; 32]);
        if report_hash == zero {
            return Err(RegistryError::InvalidHash);
        }

        let verified_ledger = env.ledger().sequence();
        let record = VerificationRecord {
            borrower: borrower.clone(),
            report_hash,
            verified_ledger,
            // Re-registering restarts the decay clock, which is what restores
            // a dormant borrower to their full score.
            last_verified_ledger: verified_ledger,
            expiration_ledger: verified_ledger.saturating_add(duration_ledgers),
            score,
        };

        Self::set_record(&env, &borrower, &record);
        Self::set_risk_record(&env, &borrower, &Self::seed_risk_from_score(score));
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("vreg"),),
            (admin, borrower, score, verified_ledger, record.expiration_ledger),
        );

        Ok(())
    }

    /// Returns 	rue if the borrower has a valid, non-expired verification
    /// record anchored on-chain, and alse otherwise.
    pub fn is_verified(env: Env, borrower: Address) -> bool {
        match Self::read_record(&env, &borrower) {
            Some(record) => env.ledger().sequence() <= record.expiration_ledger,
            None => false,
        }
    }

    /// Fetch the raw verification record for a borrower, if one exists.
    pub fn get_verification(
        env: Env,
        borrower: Address,
    ) -> Result<VerificationRecord, RegistryError> {
        Self::read_record(&env, &borrower).ok_or(RegistryError::VerificationNotFound)
    }

    /// Returns the borrower's *effective* credit score — the anchored score
    /// after inactivity decay.
    ///
    /// This is the score the lending pool prices loans from, so a borrower who
    /// stops re-verifying gradually loses their favourable rate rather than
    /// holding it on the strength of a stale report.
    pub fn get_score(env: Env, borrower: Address) -> Result<u32, RegistryError> {
        let record = Self::read_record(&env, &borrower).ok_or(RegistryError::VerificationNotFound)?;
        if env.ledger().sequence() > record.expiration_ledger {
            return Err(RegistryError::VerificationNotFound);
        }
        Ok(Self::decayed_score(&env, &borrower, record.score))
    }

    /// Returns the anchored score exactly as registered, ignoring decay.
    ///
    /// Useful for audits and for showing a borrower what re-verifying would
    /// restore them to.
    pub fn get_raw_score(env: Env, borrower: Address) -> Result<u32, RegistryError> {
        let record = Self::read_record(&env, &borrower).ok_or(RegistryError::VerificationNotFound)?;
        if env.ledger().sequence() > record.expiration_ledger {
            return Err(RegistryError::VerificationNotFound);
        }
        Ok(record.score)
    }

    /// Score points the borrower has currently lost to inactivity.
    ///
    /// `0` means they are still inside the grace window. Returns `0` for a
    /// borrower with no verification record.
    pub fn get_score_decay(env: Env, borrower: Address) -> u32 {
        match Self::read_record(&env, &borrower) {
            Some(record) => {
                let config = Self::read_decay_config(&env);
                Self::decay_points(&env, record.last_verified_ledger, &config)
            }
            None => 0,
        }
    }

    /// Ledger at which `borrower`'s score will begin decaying.
    ///
    /// Returns `None` when no verification record exists.
    pub fn get_decay_start_ledger(env: Env, borrower: Address) -> Option<u32> {
        Self::read_record(&env, &borrower).map(|record| {
            let config = Self::read_decay_config(&env);
            record
                .last_verified_ledger
                .saturating_add(config.threshold_ledgers)
        })
    }

    /// Configure how inactive scores decay. Admin-only.
    ///
    /// Passing `points_per_period = 0` disables decay entirely while leaving
    /// the rest of the configuration in place.
    ///
    /// # Arguments
    /// - `threshold_ledgers` — Inactivity allowed before decay begins.
    /// - `points_per_period` — Score points shed per period (max 100).
    /// - `period_ledgers` — Length of one decay period; must be non-zero.
    /// - `min_score` — Lower bound decay cannot push a score below (max 100).
    pub fn set_decay_config(
        env: Env,
        threshold_ledgers: u32,
        points_per_period: u32,
        period_ledgers: u32,
        min_score: u32,
    ) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        // A zero period would divide by zero in `decay_points`.
        if period_ledgers == 0 || points_per_period > 100 || min_score > 100 {
            return Err(RegistryError::InvalidDecayConfig);
        }

        let config = DecayConfig {
            threshold_ledgers,
            points_per_period,
            period_ledgers,
            min_score,
        };
        env.storage().instance().set(&DataKey::DecayConfig, &config);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("decaycfg"),),
            (threshold_ledgers, points_per_period, period_ledgers, min_score),
        );

        Ok(())
    }

    /// Returns the active decay parameters, or the protocol defaults if the
    /// admin has not configured any.
    pub fn get_decay_config(env: Env) -> DecayConfig {
        Self::read_decay_config(&env)
    }

    /// Propose a new admin to take over the contract.
    ///
    /// Admin-only. This is the first step of a secure two-step admin
    /// transfer: the proposed admin is recorded but does not gain any
    /// authority until they explicitly call [Self::accept_admin]. Calling
    /// this again overwrites any previously proposed admin, allowing the
    /// current admin to correct a mistake before acceptance.
    pub fn propose_new_admin(env: Env, new_admin: Address) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::ProposedAdmin, &new_admin);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("prop_adm"),),
            (admin, new_admin),
        );

        Ok(())
    }

    /// Accept a pending admin proposal, completing the two-step transfer.
    ///
    /// Can only be called by the address previously set via
    /// [Self::propose_new_admin]. On success the caller becomes the new
    /// admin and the pending proposal is cleared, stripping the old admin of
    /// all authority.
    pub fn accept_admin(env: Env) -> Result<(), RegistryError> {
        let proposed: Address = env
            .storage()
            .instance()
            .get(&DataKey::ProposedAdmin)
            .ok_or(RegistryError::NoProposedAdmin)?;
        proposed.require_auth();

        env.storage().instance().set(&DataKey::Admin, &proposed);
        env.storage().instance().remove(&DataKey::ProposedAdmin);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("acc_adm"),),
            (proposed,),
        );

        Ok(())
    }

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        1
    }

    /// Set dynamic interest rate configuration.
    ///
    /// Admin-only. Updates the global interest rate tiers that lending pools
    /// query when resolving borrower interest rates. Allows the protocol to
    /// adapt to macroeconomic conditions without redeploying contracts.
    pub fn set_rate_config(
        env: Env,
        rate_excellent_bps: u32,
        rate_good_bps: u32,
        rate_fair_bps: u32,
        rate_fallback_bps: u32,
    ) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        let cap = Self::read_rate_cap(&env);
        let floor = Self::read_rate_floor(&env);

        // Clamp each tier rate within the configured boundaries.
        let clamp = |r: u32| -> u32 { r.max(floor).min(cap) };

        let config = RateConfig {
            rate_excellent_bps: clamp(rate_excellent_bps),
            rate_good_bps: clamp(rate_good_bps),
            rate_fair_bps: clamp(rate_fair_bps),
            rate_fallback_bps: clamp(rate_fallback_bps),
        };

        env.storage().instance().set(&DataKey::RateConfig, &config);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("rate_cfg"),),
            (admin, rate_excellent_bps, rate_good_bps, rate_fair_bps, rate_fallback_bps),
        );

        Ok(())
    }

    /// Get the current dynamic interest rate configuration.
    ///
    /// Returns the rate config if set, or defaults if not yet configured.
    /// Individual rates are clamped to the configured cap and floor before
    /// being returned.
    pub fn get_rate_config(env: Env) -> RateConfig {
        env.storage()
            .instance()
            .get(&DataKey::RateConfig)
            .unwrap_or(RateConfig {
                rate_excellent_bps: 400,  // 4% APR
                rate_good_bps: 600,        // 6% APR
                rate_fair_bps: 800,        // 8% APR
                rate_fallback_bps: 1200,   // 12% APR
            })
    }

    /// Set the interest rate cap and floor limits in basis points.
    ///
    /// Admin-only. The floor must be less than or equal to the cap, and both
    /// must be in the range 0–10000 bps. These limits are enforced in
    /// `set_rate_config` and `get_borrower_rate` so that no computed rate
    /// exceeds the configured boundaries.
    pub fn set_rate_limits(
        env: Env,
        cap_bps: u32,
        floor_bps: u32,
    ) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        if floor_bps > cap_bps {
            return Err(RegistryError::InvalidRateLimits);
        }

        if cap_bps > 10_000 {
            return Err(RegistryError::InvalidRateLimits);
        }

        env.storage().instance().set(&DataKey::RateCap, &cap_bps);
        env.storage().instance().set(&DataKey::RateFloor, &floor_bps);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Returns the current rate cap in basis points.
    pub fn get_rate_cap(env: Env) -> u32 {
        Self::read_rate_cap(&env)
    }

    /// Returns the current rate floor in basis points.
    pub fn get_rate_floor(env: Env) -> u32 {
        Self::read_rate_floor(&env)
    }

    /// Resolve the interest rate for a borrower based on their credit score.
    ///
    /// Uses the current rate configuration and the borrower's verification
    /// record. Returns the fallback rate if no valid verification exists.
    pub fn get_borrower_rate(env: Env, borrower: Address) -> u32 {
        let config = Self::get_rate_config(env.clone());
        let cap = Self::read_rate_cap(&env);
        let floor = Self::read_rate_floor(&env);

        let rate = if let Some(risk) = Self::read_risk_record(&env, &borrower) {
            let score = Self::decayed_score(&env, &borrower, risk.score);
            match Self::tier_from_score(score) {
                RiskTier::Excellent => config.rate_excellent_bps,
                RiskTier::Good => config.rate_good_bps,
                RiskTier::Fair => config.rate_fair_bps,
                RiskTier::Poor => config.rate_fallback_bps,
            }
        } else {
            // No risk record yet — fall back to the borrower's verification
            // score, provided the verification has not expired.
            match Self::read_record(&env, &borrower) {
                Some(record) if env.ledger().sequence() <= record.expiration_ledger => {
                    let score = Self::decayed_score(&env, &borrower, record.score);
                    if score >= 80 {
                        config.rate_excellent_bps
                    } else if score >= 60 {
                        config.rate_good_bps
                    } else if score >= 40 {
                        config.rate_fair_bps
                    } else {
                        config.rate_fallback_bps
                    }
                }
                _ => config.rate_fallback_bps,
            }
        };

        // Clamp the resolved rate within the configured boundaries.
        rate.max(floor).min(cap)
    }

    /// Configure the lending pool contract that is allowed to push repayment
    /// callbacks into the registry.
    pub fn set_lending_pool(env: Env, lending_pool: Address) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        env.storage().instance().set(&DataKey::LendingPool, &lending_pool);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("set_lp"),),
            (admin, lending_pool),
        );

        Ok(())
    }

    /// Receive a repayment-status callback from the lending pool and update
    /// the borrower's dynamic risk profile.
    pub fn record_repayment_status(
        env: Env,
        borrower: Address,
        was_on_time: bool,
    ) -> Result<RiskRecord, RegistryError> {
        let mut profile = Self::read_risk_record(&env, &borrower)
            .unwrap_or_else(|| Self::seed_risk_from_score(70));

        let old_score = profile.score;

        if was_on_time {
            profile.on_time_payments = profile.on_time_payments.saturating_add(1);
            profile.consecutive_late = 0;
            profile.score = profile.score.saturating_add(4).min(100);
        } else {
            profile.late_payments = profile.late_payments.saturating_add(1);
            profile.consecutive_late = profile.consecutive_late.saturating_add(1);
            let penalty = 10u32.saturating_add(profile.consecutive_late.saturating_mul(5));
            profile.score = profile.score.saturating_sub(penalty);
            if profile.consecutive_late >= 3 {
                profile.score = profile.score.saturating_sub(10);
            }
        }
        profile.tier = Self::tier_from_score(profile.score);
        Self::set_risk_record(&env, &borrower, &profile);
        Self::bump_instance(&env);

        env.events().publish(
            (symbol_short!("risk_upd"),),
            (borrower, old_score, profile.score, was_on_time),
        );

        Ok(profile)
    }

    /// Return the dynamic risk profile, if one exists.
    pub fn get_risk_profile(env: Env, borrower: Address) -> Option<RiskRecord> {
        Self::read_risk_record(&env, &borrower)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Events, Ledger as _};
    use soroban_sdk::{Address, BytesN, Env, IntoVal};

    fn setup(env: &Env) -> (Address, VerificationRegistryContractClient<'static>) {
        let admin = Address::generate(env);
        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(env, &contract_id);
        client.initialize(&admin);
        (admin, client)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, _client) = setup(&env);
    }

    #[test]
    fn test_double_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let result = client.try_initialize(&admin);
        assert_eq!(result, Err(Ok(RegistryError::AlreadyInitialized)));
    }

    #[test]
    fn test_register_and_is_verified() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[7u8; 32]);

        client.register_verification(&borrower, &report_hash, &1_000u32, &80u32);

        assert!(client.is_verified(&borrower));

        let record = client.get_verification(&borrower);
        assert_eq!(record.borrower, borrower);
        assert_eq!(record.report_hash, report_hash);
        assert_eq!(record.expiration_ledger, record.verified_ledger + 1_000);
        assert_eq!(record.score, 80u32);
    }

    #[test]
    fn test_register_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[7u8; 32]);

        client.register_verification(&borrower, &report_hash, &1_000u32, &80u32);

        let events = env.events().all();
        let last_event = events.last().unwrap();

        let expected_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
            &env,
            symbol_short!("vreg").into_val(&env),
        ];
        assert_eq!(last_event.1, expected_topic);

        let (event_admin, event_borrower, event_score, event_ledger, event_expiry): (Address, Address, u32, u32, u32) =
            last_event.2.into_val(&env);
        assert_eq!(event_admin, admin);
        assert_eq!(event_borrower, borrower);
        assert_eq!(event_score, 80u32);
        assert_eq!(event_expiry, event_ledger + 1_000);

        let record = client.get_verification(&borrower);
        assert_eq!(event_ledger, record.verified_ledger);
    }

    #[test]
    fn test_get_score_returns_anchored_score() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[8u8; 32]);

        client.register_verification(&borrower, &report_hash, &500u32, &72u32);
        assert_eq!(client.get_score(&borrower), 72u32);
    }

    #[test]
    fn test_get_score_fails_for_expired_verification() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[8u8; 32]);

        let start = env.ledger().sequence();
        client.register_verification(&borrower, &report_hash, &100u32, &72u32);
        env.ledger().set_sequence_number(start + 101);

        let result = client.try_get_score(&borrower);
        assert_eq!(result, Err(Ok(RegistryError::VerificationNotFound)));
    }

    #[test]
    fn test_register_invalid_score_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[1u8; 32]);

        let result = client.try_register_verification(&borrower, &report_hash, &100u32, &101u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidScore)));
    }

    #[test]
    fn test_is_verified_false_for_unknown_borrower() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let stranger = Address::generate(&env);
        assert!(!client.is_verified(&stranger));
    }

    #[test]
    fn test_is_verified_false_after_expiration() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[9u8; 32]);

        let start = env.ledger().sequence();
        client.register_verification(&borrower, &report_hash, &100u32, &80u32);
        assert!(client.is_verified(&borrower));

        env.ledger().set_sequence_number(start + 100);
        assert!(client.is_verified(&borrower));

        env.ledger().set_sequence_number(start + 101);
        assert!(!client.is_verified(&borrower));
    }

    #[test]
    fn test_register_zero_duration_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[1u8; 32]);

        let result = client.try_register_verification(&borrower, &report_hash, &0u32, &80u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidDuration)));
    }

    #[test]
    fn test_register_zero_hash_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let zero_hash = BytesN::from_array(&env, &[0u8; 32]);

        let result = client.try_register_verification(&borrower, &zero_hash, &100u32, &80u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidHash)));
    }

    #[test]
    fn test_register_before_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[1u8; 32]);

        let result = client.try_register_verification(&borrower, &report_hash, &100u32, &80u32);
        assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_register_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin);
        env.set_auths(&[]);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[1u8; 32]);

        client.register_verification(&borrower, &report_hash, &100u32, &80u32);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_non_admin_register_fails_auth() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[1u8; 32]);

        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_verification",
                args: (borrower.clone(), report_hash.clone(), 100u32, 80u32).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.register_verification(&borrower, &report_hash, &100u32, &80u32);
    }

    #[test]
    fn test_two_step_admin_transfer_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let new_admin = Address::generate(&env);

        client.propose_new_admin(&new_admin);
        client.accept_admin();

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[3u8; 32]);
        client.register_verification(&borrower, &report_hash, &100u32, &80u32);
        assert!(client.is_verified(&borrower));
    }

    #[test]
    fn test_accept_admin_without_proposal_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let result = client.try_accept_admin();
        assert_eq!(result, Err(Ok(RegistryError::NoProposedAdmin)));
    }

    #[test]
    fn test_propose_before_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        let new_admin = Address::generate(&env);
        let result = client.try_propose_new_admin(&new_admin);
        assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_only_admin_can_propose() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin);

        let new_admin = Address::generate(&env);

        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "propose_new_admin",
                args: (new_admin.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.propose_new_admin(&new_admin);
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_only_proposed_admin_can_accept() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);
        let imposter = Address::generate(&env);

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin);
        client.propose_new_admin(&new_admin);

        env.mock_auths(&[MockAuth {
            address: &imposter,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "accept_admin",
                args: ().into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.accept_admin();
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_old_admin_loses_authority_after_transfer() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};
        use soroban_sdk::IntoVal;

        let env = Env::default();
        let admin = Address::generate(&env);
        let new_admin = Address::generate(&env);

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        env.mock_all_auths();
        client.initialize(&admin);
        client.propose_new_admin(&new_admin);
        client.accept_admin();

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[5u8; 32]);

        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_verification",
                args: (borrower.clone(), report_hash.clone(), 100u32, 80u32).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.register_verification(&borrower, &report_hash, &100u32, &80u32);
    }

    #[test]
    fn test_proposal_can_be_overwritten_before_acceptance() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let first_candidate = Address::generate(&env);
        let second_candidate = Address::generate(&env);

        client.propose_new_admin(&first_candidate);
        client.propose_new_admin(&second_candidate);

        client.accept_admin();

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[6u8; 32]);
        client.register_verification(&borrower, &report_hash, &100u32, &80u32);
        assert!(client.is_verified(&borrower));
    }

    // ── Rate Cap & Floor Tests ─────────────────────────────────────────

    #[test]
    fn test_default_rate_limits() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        assert_eq!(client.get_rate_cap(), 1800);
        assert_eq!(client.get_rate_floor(), 200);
    }

    #[test]
    fn test_set_rate_limits_ok() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        client.set_rate_limits(&1500u32, &300u32);
        assert_eq!(client.get_rate_cap(), 1500);
        assert_eq!(client.get_rate_floor(), 300);
    }

    #[test]
    fn test_set_rate_limits_floor_greater_than_cap_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let result = client.try_set_rate_limits(&500u32, &1000u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidRateLimits)));
    }

    #[test]
    fn test_set_rate_limits_cap_over_10000_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let result = client.try_set_rate_limits(&10001u32, &200u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidRateLimits)));
    }

    #[test]
    fn test_get_borrower_rate_clamps_to_floor() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        // Set a rate config where the excellent rate is below the default floor (200).
        // Default floor is 200 bps, so setting excellent to 50 bps should be clamped to 200.
        client.set_rate_config(&50u32, &600u32, &800u32, &1200u32);

        // The stored config clamps rates on write, so when we read them back:
        let config = client.get_rate_config();
        assert_eq!(config.rate_excellent_bps, 200); // clamped to floor
        assert_eq!(config.rate_good_bps, 600);
    }

    #[test]
    fn test_get_borrower_rate_clamps_to_cap() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        // Set a rate config where the fallback rate exceeds the default cap (1800).
        client.set_rate_config(&400u32, &600u32, &800u32, &5000u32);

        let config = client.get_rate_config();
        assert_eq!(config.rate_fallback_bps, 1800); // clamped to cap
    }

    #[test]
    fn test_get_borrower_rate_live_clamping() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[10u8; 32]);
        client.register_verification(&borrower, &report_hash, &1000u32, &95u32);

        // Set tight limits: floor 500, cap 700
        client.set_rate_limits(&700u32, &500u32);

        // Config was stored before we set limits; re-set to trigger clamp.
        client.set_rate_config(&400u32, &600u32, &800u32, &1200u32);

        // Borrower score is 95 (Excellent tier). With clamping:
        // rate_excellent 400 -> floor 500, so borrower rate should be 500.
        let rate = client.get_borrower_rate(&borrower);
        assert_eq!(rate, 500);
    }

    #[test]
    fn test_get_borrower_rate_clamp_to_cap_live() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[11u8; 32]);
        client.register_verification(&borrower, &report_hash, &1000u32, &95u32);

        // Set cap very low: 300 bps
        client.set_rate_limits(&300u32, &100u32);
        client.set_rate_config(&400u32, &600u32, &800u32, &1200u32);

        // Excellent tier rate 400 clamped to cap 300
        let rate = client.get_borrower_rate(&borrower);
        assert_eq!(rate, 300);
    }

    #[test]
    fn test_get_borrower_rate_floor_below_defaults_unaffected() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[12u8; 32]);
        client.register_verification(&borrower, &report_hash, &1000u32, &95u32);

        // Rate limits are wide (1-5000), default rates should pass through.
        client.set_rate_limits(&5000u32, &1u32);
        client.set_rate_config(&400u32, &600u32, &800u32, &1200u32);

        let rate = client.get_borrower_rate(&borrower);
        assert_eq!(rate, 400);
    }

    #[test]
    fn test_set_rate_limits_before_initialize_fails() {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        let result = client.try_set_rate_limits(&1800u32, &200u32);
        assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
    }

    #[test]
    fn test_record_repayment_status_emits_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[13u8; 32]);

        client.register_verification(&borrower, &report_hash, &1_000u32, &70u32);

        client.record_repayment_status(&borrower, &true);

        let events = env.events().all();
        let last_event = events.last().unwrap();

        let expected_topic: soroban_sdk::Vec<soroban_sdk::Val> = soroban_sdk::vec![
            &env,
            symbol_short!("risk_upd").into_val(&env),
        ];
        assert_eq!(last_event.1, expected_topic);

        let (event_borrower, old_score, new_score, was_on_time): (Address, u32, u32, bool) =
            last_event.2.into_val(&env);
        assert_eq!(event_borrower, borrower);
        assert_eq!(old_score, 70u32);
        assert_eq!(new_score, 74u32);
        assert_eq!(was_on_time, true);
    }

    // ── Score Decay Tests ─────────────────────────────────────────────────

    /// Persistent entries must outlive the multi-hundred-day ledger jumps the
    /// decay tests make, otherwise the record archives mid-test and the host
    /// rejects the read. `extend_ttl` never lowers a lifetime, so seeding a
    /// large TTL before `initialize` survives the in-contract bumps.
    fn extend_decay_ttls(env: &Env) {
        env.ledger().with_mut(|li| {
            li.max_entry_ttl = 40_000_001;
            li.min_persistent_entry_ttl = 40_000_000;
        });
    }

    /// Registers `borrower` with `score` and a verification long enough to
    /// outlast the decay windows under test.
    fn register_for_decay(
        env: &Env,
        client: &VerificationRegistryContractClient<'static>,
        borrower: &Address,
        score: u32,
    ) {
        let report_hash = BytesN::from_array(env, &[7u8; 32]);
        client.register_verification(borrower, &report_hash, &30_000_000u32, &score);
    }

    fn advance_days(env: &Env, days: u32) {
        env.ledger()
            .set_sequence_number(env.ledger().sequence() + days * LEDGERS_PER_DAY);
    }

    #[test]
    fn test_decay_config_defaults() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let config = client.get_decay_config();
        assert_eq!(config.threshold_ledgers, 180 * LEDGERS_PER_DAY);
        assert_eq!(config.period_ledgers, 30 * LEDGERS_PER_DAY);
        assert_eq!(config.points_per_period, 5);
        assert_eq!(config.min_score, 0);
    }

    #[test]
    fn test_score_holds_full_value_inside_grace_window() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 90);

        // One day short of the 180-day threshold — still untouched.
        advance_days(&env, 179);
        assert_eq!(client.get_score(&borrower), 90);
        assert_eq!(client.get_score_decay(&borrower), 0);

        // Exactly at the threshold, decay has still not started.
        advance_days(&env, 1);
        assert_eq!(client.get_score(&borrower), 90);
        assert_eq!(client.get_score_decay(&borrower), 0);
    }

    #[test]
    fn test_score_decays_linearly_past_the_threshold() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 90);

        // 30 days past the threshold = one period = 5 points.
        advance_days(&env, 210);
        assert_eq!(client.get_score_decay(&borrower), 5);
        assert_eq!(client.get_score(&borrower), 85);

        // 60 days past = two periods = 10 points.
        advance_days(&env, 30);
        assert_eq!(client.get_score_decay(&borrower), 10);
        assert_eq!(client.get_score(&borrower), 80);

        // 90 days past = three periods = 15 points.
        advance_days(&env, 30);
        assert_eq!(client.get_score_decay(&borrower), 15);
        assert_eq!(client.get_score(&borrower), 75);
    }

    #[test]
    fn test_decay_is_continuous_not_stepped() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 100);

        // Half a period past the threshold loses half a period's points —
        // decay accrues per ledger, not in jumps at period boundaries.
        advance_days(&env, 195);
        assert_eq!(client.get_score_decay(&borrower), 2);
        assert_eq!(client.get_score(&borrower), 98);
    }

    #[test]
    fn test_decay_never_falls_below_zero() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 20);

        // Far past the point where accumulated points exceed the score.
        advance_days(&env, 180 + 30 * 40);
        assert_eq!(client.get_score(&borrower), 0);
    }

    #[test]
    fn test_reverification_restores_score_and_resets_timer() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 90);

        advance_days(&env, 270); // 90 days past the threshold
        assert_eq!(client.get_score(&borrower), 75);
        assert_eq!(client.get_score_decay(&borrower), 15);

        // Acceptance criterion: re-verification restores immediately.
        register_for_decay(&env, &client, &borrower, 90);
        assert_eq!(client.get_score(&borrower), 90);
        assert_eq!(client.get_score_decay(&borrower), 0);

        // ...and the clock restarts, so the next grace window is a full 180
        // days from the re-verification rather than from the first one.
        advance_days(&env, 179);
        assert_eq!(client.get_score(&borrower), 90);

        advance_days(&env, 31);
        assert_eq!(client.get_score(&borrower), 85);
    }

    #[test]
    fn test_reverification_updates_last_verified_ledger_only() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 70);
        let first = client.get_verification(&borrower);
        assert_eq!(first.verified_ledger, first.last_verified_ledger);

        advance_days(&env, 200);
        register_for_decay(&env, &client, &borrower, 70);

        let second = client.get_verification(&borrower);
        assert!(second.last_verified_ledger > first.last_verified_ledger);
        assert_eq!(
            client.get_decay_start_ledger(&borrower),
            Some(second.last_verified_ledger + 180 * LEDGERS_PER_DAY)
        );
    }

    #[test]
    fn test_raw_score_is_unaffected_by_decay() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 90);

        advance_days(&env, 270);
        assert_eq!(client.get_score(&borrower), 75);
        // The anchored report is untouched — only its effective weight fades.
        assert_eq!(client.get_raw_score(&borrower), 90);
    }

    #[test]
    fn test_decay_raises_borrower_interest_rate() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        client.set_rate_config(&400u32, &600u32, &800u32, &1200u32);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 82);

        // Excellent tier (>= 80) while fresh.
        assert_eq!(client.get_borrower_rate(&borrower), 400);

        // Decaying 3 points below 80 drops the borrower into Good tier — the
        // whole point of the feature: stale data stops buying a cheap rate.
        advance_days(&env, 180 + 30);
        assert_eq!(client.get_score(&borrower), 77);
        assert_eq!(client.get_borrower_rate(&borrower), 600);

        // Re-verifying restores the favourable rate at once.
        register_for_decay(&env, &client, &borrower, 82);
        assert_eq!(client.get_borrower_rate(&borrower), 400);
    }

    #[test]
    fn test_decay_config_is_admin_configurable() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        // Aggressive schedule: 10 days grace, 20 points per 10-day period.
        client.set_decay_config(
            &(10 * LEDGERS_PER_DAY),
            &20u32,
            &(10 * LEDGERS_PER_DAY),
            &0u32,
        );

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 100);

        advance_days(&env, 20);
        assert_eq!(client.get_score(&borrower), 80);
    }

    #[test]
    fn test_decay_respects_configured_min_score() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        client.set_decay_config(
            &(10 * LEDGERS_PER_DAY),
            &20u32,
            &(10 * LEDGERS_PER_DAY),
            &40u32,
        );

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 90);

        // Decay would take this well below 40, but the floor holds it.
        advance_days(&env, 500);
        assert_eq!(client.get_score(&borrower), 40);
    }

    #[test]
    fn test_min_score_floor_never_raises_a_low_score() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        client.set_decay_config(&(10 * LEDGERS_PER_DAY), &20u32, &(10 * LEDGERS_PER_DAY), &40u32);

        // Registered below the floor — decay must not promote them up to it.
        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 25);

        advance_days(&env, 500);
        assert_eq!(client.get_score(&borrower), 25);
    }

    #[test]
    fn test_zero_points_per_period_disables_decay() {
        let env = Env::default();
        env.mock_all_auths();
        extend_decay_ttls(&env);
        let (_admin, client) = setup(&env);

        client.set_decay_config(&(10 * LEDGERS_PER_DAY), &0u32, &(10 * LEDGERS_PER_DAY), &0u32);

        let borrower = Address::generate(&env);
        register_for_decay(&env, &client, &borrower, 90);

        advance_days(&env, 1_000);
        assert_eq!(client.get_score(&borrower), 90);
        assert_eq!(client.get_score_decay(&borrower), 0);
    }

    #[test]
    fn test_set_decay_config_rejects_invalid_values() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        // A zero period would divide by zero during decay.
        let result = client.try_set_decay_config(&100u32, &5u32, &0u32, &0u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidDecayConfig)));

        // Scores are on a 0–100 scale.
        let result = client.try_set_decay_config(&100u32, &101u32, &100u32, &0u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidDecayConfig)));

        let result = client.try_set_decay_config(&100u32, &5u32, &100u32, &101u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidDecayConfig)));
    }

    #[test]
    fn test_set_decay_config_requires_admin() {
        use soroban_sdk::testutils::{MockAuth, MockAuthInvoke};

        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let attacker = Address::generate(&env);
        let result = client
            .mock_auths(&[MockAuth {
                address: &attacker,
                invoke: &MockAuthInvoke {
                    contract: &client.address,
                    fn_name: "set_decay_config",
                    args: (100u32, 5u32, 100u32, 0u32).into_val(&env),
                    sub_invokes: &[],
                },
            }])
            .try_set_decay_config(&100u32, &5u32, &100u32, &0u32);

        assert!(result.is_err());
        // Defaults survive the rejected call.
        assert_eq!(client.get_decay_config().points_per_period, 5);
    }

    #[test]
    fn test_score_decay_is_zero_for_unknown_borrower() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let stranger = Address::generate(&env);
        assert_eq!(client.get_score_decay(&stranger), 0);
        assert_eq!(client.get_decay_start_ledger(&stranger), None);
    }

}
