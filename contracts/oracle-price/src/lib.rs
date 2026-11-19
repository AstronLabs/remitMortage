// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

/// Maximum number of authorized reporters. Bounds the per-`get_price` scan
/// (and the O(n^2) median computation) to a small, fixed cost.
const MAX_REPORTERS: u32 = 20;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    /// `initialize` called more than once.
    AlreadyInitialized = 1,
    /// Caller is not the configured reporter and did not authorize as one.
    Unauthorized = 2,
    /// The oracle is halted (single-admin deviation guard tripped).
    OracleHalted = 3,
    /// The address is already a configured reporter.
    ReporterAlreadyExists = 4,
    /// The address is not a configured reporter.
    ReporterNotFound = 5,
    /// Adding this reporter would exceed `MAX_REPORTERS`.
    TooManyReporters = 6,
    /// `min_quorum` must be greater than zero.
    InvalidQuorum = 7,
    /// Fewer than `min_quorum` fresh, non-outlier reports are available.
    QuorumNotMet = 8,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Price,
    Observations,
    DeviationConfig,
    HaltFlag,
    /// Authorized multi-source reporters.
    Reporters,
    /// A reporter's latest submission.
    ReporterSubmission(Address),
    /// Multi-source aggregation settings. Its presence switches `get_price`
    /// from the legacy single-admin TWAP to the median-of-reporters path.
    AggregationConfig,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub updated_ledger: u32,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct DeviationConfig {
    pub max_deviation_bps: u32,
    pub window_ledgers: u32,
}

/// A single reporter's latest price submission.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct ReporterSubmission {
    pub price: i128,
    pub updated_ledger: u32,
}

/// Multi-source median aggregation settings.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AggregationConfig {
    /// Minimum number of fresh, non-outlier reports required to return a price.
    pub min_quorum: u32,
    /// A submission older than this many ledgers is not "fresh" and is excluded.
    pub max_staleness_ledgers: u32,
    /// A fresh report deviating from the pre-filter median by more than this
    /// many basis points is discarded as an outlier before the final median.
    pub max_deviation_bps: u32,
}

#[contract]
pub struct OraclePriceContract;

impl OraclePriceContract {
    fn read_observations(env: &Env) -> Vec<PriceData> {
        env.storage()
            .instance()
            .get(&DataKey::Observations)
            .unwrap_or_else(|| Vec::new(env))
    }

    fn read_reporters(env: &Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Reporters)
            .unwrap_or_else(|| Vec::new(env))
    }

    /// Median of `values`. Selection sort via repeated min-extraction —
    /// `Vec<i128>` has no built-in sort, and reporter counts are small
    /// (bounded by `MAX_REPORTERS`), so O(n^2) is fine.
    fn median(env: &Env, values: &Vec<i128>) -> i128 {
        let mut remaining = values.clone();
        let mut sorted: Vec<i128> = Vec::new(env);
        while !remaining.is_empty() {
            let mut min_index: u32 = 0;
            let mut min_value = remaining.get_unchecked(0);
            for i in 1..remaining.len() {
                let candidate = remaining.get_unchecked(i);
                if candidate < min_value {
                    min_value = candidate;
                    min_index = i;
                }
            }
            sorted.push_back(min_value);
            remaining.remove(min_index);
        }

        let len = sorted.len();
        let mid = len / 2;
        if len.is_multiple_of(2) {
            // Average the two middle values. Integer division truncates
            // toward zero, which is an acceptable, documented rounding
            // choice for an even-count median of a price in minor units.
            (sorted.get_unchecked(mid - 1) + sorted.get_unchecked(mid)) / 2
        } else {
            sorted.get_unchecked(mid)
        }
    }

    /// Returns the deviation of `price` from `reference`, in basis points of
    /// `reference`'s absolute value. A `reference` of exactly zero is treated
    /// as "any non-zero price deviates infinitely" (returns `u32::MAX`)
    /// rather than dividing by zero.
    fn deviation_bps(price: i128, reference: i128) -> u32 {
        if reference == 0 {
            return if price == 0 { 0 } else { u32::MAX };
        }
        let diff = if price > reference {
            price - reference
        } else {
            reference - price
        };
        let bps = diff.saturating_mul(10_000) / reference.abs();
        if bps > u32::MAX as i128 {
            u32::MAX
        } else {
            bps as u32
        }
    }

    /// The multi-source aggregated price: the median of every reporter's
    /// fresh submission, with outliers beyond `max_deviation_bps` of that
    /// first-pass median discarded before taking the final median. Requires
    /// at least `min_quorum` reports to survive both the freshness filter and
    /// the outlier filter.
    fn aggregated_price(env: &Env, config: &AggregationConfig) -> Result<i128, OracleError> {
        let reporters = Self::read_reporters(env);
        let current_ledger = env.ledger().sequence();

        let mut fresh: Vec<i128> = Vec::new(env);
        for i in 0..reporters.len() {
            let reporter = reporters.get_unchecked(i);
            let submission: Option<ReporterSubmission> = env
                .storage()
                .instance()
                .get(&DataKey::ReporterSubmission(reporter));
            if let Some(sub) = submission {
                let age = current_ledger.saturating_sub(sub.updated_ledger);
                if age <= config.max_staleness_ledgers {
                    fresh.push_back(sub.price);
                }
            }
        }

        if fresh.len() < config.min_quorum {
            return Err(OracleError::QuorumNotMet);
        }

        let pre_filter_median = Self::median(env, &fresh);

        let mut filtered: Vec<i128> = Vec::new(env);
        for i in 0..fresh.len() {
            let price = fresh.get_unchecked(i);
            if Self::deviation_bps(price, pre_filter_median) <= config.max_deviation_bps {
                filtered.push_back(price);
            }
        }

        if filtered.len() < config.min_quorum {
            return Err(OracleError::QuorumNotMet);
        }

        Ok(Self::median(env, &filtered))
    }

    fn configured_window(env: &Env) -> u32 {
        let config: Option<DeviationConfig> =
            env.storage().instance().get(&DataKey::DeviationConfig);
        config.map(|c| c.window_ledgers).unwrap_or(0)
    }

    fn window_start(current_ledger: u32, window_ledgers: u32) -> u32 {
        current_ledger.saturating_sub(window_ledgers.saturating_sub(1))
    }

    fn prune_observations(
        env: &Env,
        observations: &Vec<PriceData>,
        current_ledger: u32,
    ) -> Vec<PriceData> {
        let window_ledgers = Self::configured_window(env);
        if window_ledgers == 0 {
            let mut latest_only = Vec::new(env);
            if !observations.is_empty() {
                latest_only.push_back(observations.get_unchecked(observations.len() - 1));
            }
            return latest_only;
        }

        let start = Self::window_start(current_ledger, window_ledgers);
        let mut pruned = Vec::new(env);
        let mut anchor: Option<PriceData> = None;
        for i in 0..observations.len() {
            let observation = observations.get_unchecked(i);
            if observation.updated_ledger < start {
                anchor = Some(observation);
            } else {
                pruned.push_back(observation);
            }
        }

        if let Some(anchor_observation) = anchor {
            let mut with_anchor = Vec::new(env);
            with_anchor.push_back(anchor_observation);
            for i in 0..pruned.len() {
                with_anchor.push_back(pruned.get_unchecked(i));
            }
            with_anchor
        } else {
            pruned
        }
    }

    fn twap_price(env: &Env) -> i128 {
        let current_ledger = env.ledger().sequence();
        let window_ledgers = Self::configured_window(env);
        if window_ledgers == 0 {
            let price_data: PriceData = env.storage().instance().get(&DataKey::Price).unwrap();
            return price_data.price;
        }

        let observations = Self::read_observations(env);
        let start = Self::window_start(current_ledger, window_ledgers);
        let mut total = 0i128;
        let mut covered_ledgers = 0u32;
        let mut active_price: Option<i128> = None;
        let mut segment_start = start;

        for i in 0..observations.len() {
            let observation = observations.get_unchecked(i);
            if observation.updated_ledger < start {
                active_price = Some(observation.price);
                continue;
            }
            if observation.updated_ledger > current_ledger {
                break;
            }

            if let Some(price) = active_price {
                let duration = observation.updated_ledger.saturating_sub(segment_start);
                total = total.saturating_add(price.saturating_mul(duration as i128));
                covered_ledgers = covered_ledgers.saturating_add(duration);
            }

            active_price = Some(observation.price);
            segment_start = observation.updated_ledger;
        }

        if let Some(price) = active_price {
            let duration = current_ledger
                .saturating_sub(segment_start)
                .saturating_add(1);
            total = total.saturating_add(price.saturating_mul(duration as i128));
            covered_ledgers = covered_ledgers.saturating_add(duration);
        }

        if covered_ledgers == 0 {
            let price_data: PriceData = env.storage().instance().get(&DataKey::Price).unwrap();
            price_data.price
        } else {
            total / covered_ledgers as i128
        }
    }
}

#[contractimpl]
impl OraclePriceContract {
    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::HaltFlag, &false);
    }

    pub fn set_deviation_config(env: Env, config: DeviationConfig) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::DeviationConfig, &config);
    }

    pub fn update_price(env: Env, new_price: i128) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();

        let current_ledger = env.ledger().sequence();
        let halt_flag: bool = env
            .storage()
            .instance()
            .get(&DataKey::HaltFlag)
            .unwrap_or(false);

        if halt_flag {
            panic!("Oracle halted");
        }

        let config_opt: Option<DeviationConfig> =
            env.storage().instance().get(&DataKey::DeviationConfig);
        let last_price_opt: Option<PriceData> = env.storage().instance().get(&DataKey::Price);

        if let (Some(conf), Some(last_price)) = (config_opt, last_price_opt) {
            if current_ledger <= last_price.updated_ledger + conf.window_ledgers
                && last_price.price > 0
            {
                let diff = if new_price > last_price.price {
                    new_price - last_price.price
                } else {
                    last_price.price - new_price
                };

                let deviation_bps = (diff * 10000) / last_price.price;

                if deviation_bps > conf.max_deviation_bps as i128 {
                    env.storage().instance().set(&DataKey::HaltFlag, &true);
                    return; // Halt without updating the price
                }
            }
        }

        let price_data = PriceData {
            price: new_price,
            updated_ledger: current_ledger,
        };
        env.storage().instance().set(&DataKey::Price, &price_data);

        let mut observations = Self::read_observations(&env);
        observations.push_back(price_data);
        let pruned = Self::prune_observations(&env, &observations, current_ledger);
        env.storage()
            .instance()
            .set(&DataKey::Observations, &pruned);
    }

    /// Returns the current price. When multi-source aggregation is
    /// configured (`set_aggregation_config` has been called), this is the
    /// median of fresh, non-outlier reporter submissions — see
    /// `aggregated_price`. Otherwise it falls back to the original
    /// single-admin rolling TWAP, unchanged, so a deployment that never
    /// adopts reporters keeps its exact prior behavior.
    ///
    /// The read interface itself — call `get_price()`, get an `i128` back —
    /// is unchanged for existing callers: a `Result`-returning function still
    /// yields its `Ok` value directly through the non-`try_` client method.
    /// Only a caller using `try_get_price()` sees the new, typed
    /// `QuorumNotMet` error instead of a stale or halted price.
    pub fn get_price(env: Env) -> Result<i128, OracleError> {
        let halt_flag: bool = env
            .storage()
            .instance()
            .get(&DataKey::HaltFlag)
            .unwrap_or(false);
        if halt_flag {
            return Err(OracleError::OracleHalted);
        }

        let agg_config: Option<AggregationConfig> =
            env.storage().instance().get(&DataKey::AggregationConfig);
        match agg_config {
            Some(config) => Self::aggregated_price(&env, &config),
            None => Ok(Self::twap_price(&env)),
        }
    }

    pub fn is_halted(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::HaltFlag)
            .unwrap_or(false)
    }

    pub fn clear_halt(env: Env) {
        let admin: Address = env.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        env.storage().instance().set(&DataKey::HaltFlag, &false);
    }

    // ── Multi-source median aggregation ─────────────────────────────────────

    /// Admin-only. Sets quorum/staleness/deviation settings and switches
    /// `get_price` onto the median-of-reporters path for every call after
    /// this one.
    pub fn set_aggregation_config(env: Env, config: AggregationConfig) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(OracleError::Unauthorized)?;
        admin.require_auth();

        if config.min_quorum == 0 {
            return Err(OracleError::InvalidQuorum);
        }

        env.storage()
            .instance()
            .set(&DataKey::AggregationConfig, &config);
        Ok(())
    }

    /// Admin-only. Authorizes `reporter` to call `submit_price`.
    pub fn add_reporter(env: Env, reporter: Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(OracleError::Unauthorized)?;
        admin.require_auth();

        let mut reporters = Self::read_reporters(&env);
        for i in 0..reporters.len() {
            if reporters.get_unchecked(i) == reporter {
                return Err(OracleError::ReporterAlreadyExists);
            }
        }
        if reporters.len() >= MAX_REPORTERS {
            return Err(OracleError::TooManyReporters);
        }

        reporters.push_back(reporter.clone());
        env.storage()
            .instance()
            .set(&DataKey::Reporters, &reporters);

        env.events()
            .publish((symbol_short!("rep_add"),), (reporter,));
        Ok(())
    }

    /// Admin-only. Revokes `reporter`'s authorization. Rotating the reporter
    /// set this way (remove the old one, add a replacement) immediately
    /// excludes the removed reporter's submissions from future aggregation —
    /// their last submission, if any, is left in storage but is simply never
    /// read again since `get_price` only iterates the current reporter list.
    pub fn remove_reporter(env: Env, reporter: Address) -> Result<(), OracleError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(OracleError::Unauthorized)?;
        admin.require_auth();

        let mut reporters = Self::read_reporters(&env);
        let mut found_index: Option<u32> = None;
        for i in 0..reporters.len() {
            if reporters.get_unchecked(i) == reporter {
                found_index = Some(i);
                break;
            }
        }
        let index = found_index.ok_or(OracleError::ReporterNotFound)?;
        reporters.remove(index);
        env.storage()
            .instance()
            .set(&DataKey::Reporters, &reporters);

        env.events()
            .publish((symbol_short!("rep_rm"),), (reporter,));
        Ok(())
    }

    /// Submit a fresh price as an authorized reporter. Only the single
    /// latest submission per reporter is kept — `get_price` reads it by
    /// freshness (`max_staleness_ledgers`), not by submission history.
    pub fn submit_price(env: Env, reporter: Address, price: i128) -> Result<(), OracleError> {
        reporter.require_auth();

        let reporters = Self::read_reporters(&env);
        let mut authorized = false;
        for i in 0..reporters.len() {
            if reporters.get_unchecked(i) == reporter {
                authorized = true;
                break;
            }
        }
        if !authorized {
            return Err(OracleError::Unauthorized);
        }

        let submission = ReporterSubmission {
            price,
            updated_ledger: env.ledger().sequence(),
        };
        env.storage()
            .instance()
            .set(&DataKey::ReporterSubmission(reporter.clone()), &submission);

        env.events().publish(
            (symbol_short!("price_sub"), reporter),
            (price, submission.updated_ledger),
        );
        Ok(())
    }
}

#[cfg(test)]
mod test {
    extern crate std;

    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup(env: &Env, window_ledgers: u32) -> (Address, OraclePriceContractClient<'_>) {
        env.mock_all_auths();
        let contract_id = env.register(OraclePriceContract, ());
        let client = OraclePriceContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client.set_deviation_config(&DeviationConfig {
            max_deviation_bps: 1_000_000,
            window_ledgers,
        });
        (admin, client)
    }

    fn update_at(env: &Env, client: &OraclePriceContractClient<'_>, ledger: u32, price: i128) {
        env.ledger().set_sequence_number(ledger);
        client.update_price(&price);
    }

    #[test]
    fn get_price_returns_rolling_window_twap() {
        let env = Env::default();
        let (_admin, client) = setup(&env, 3);

        update_at(&env, &client, 1, 100);
        update_at(&env, &client, 2, 200);
        update_at(&env, &client, 3, 300);
        assert_eq!(client.get_price(), 200);

        update_at(&env, &client, 4, 400);
        assert_eq!(client.get_price(), 300);
    }

    #[test]
    fn single_block_price_spike_only_contributes_one_window_share() {
        let env = Env::default();
        let (_admin, client) = setup(&env, 10);

        for ledger in 1..=9 {
            update_at(&env, &client, ledger, 100);
        }
        assert_eq!(client.get_price(), 100);

        update_at(&env, &client, 10, 1_000);

        let twap = client.get_price();
        let expected_one_block_share = ((100 * 9) + 1_000) / 10;

        assert_ne!(twap, 1_000);
        assert_eq!(twap, expected_one_block_share);
        assert_eq!(twap - 100, (1_000 - 100) / 10);
    }

    // ── Multi-source median aggregation ─────────────────────────────────────

    /// Initializes the oracle with no reporters and the given aggregation
    /// settings, but deliberately does NOT touch `set_deviation_config` /
    /// `update_price` — these tests exercise only the new reporter path.
    fn setup_aggregated(
        env: &Env,
        min_quorum: u32,
        max_staleness_ledgers: u32,
        max_deviation_bps: u32,
    ) -> (Address, OraclePriceContractClient<'_>) {
        env.mock_all_auths();
        let contract_id = env.register(OraclePriceContract, ());
        let client = OraclePriceContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.initialize(&admin);
        client.set_aggregation_config(&AggregationConfig {
            min_quorum,
            max_staleness_ledgers,
            max_deviation_bps,
        });
        (admin, client)
    }

    fn submit_at(
        env: &Env,
        client: &OraclePriceContractClient<'_>,
        reporter: &Address,
        ledger: u32,
        price: i128,
    ) {
        env.ledger().set_sequence_number(ledger);
        client.submit_price(reporter, &price);
    }

    #[test]
    fn stale_reporter_is_excluded_from_the_median() {
        let env = Env::default();
        let (_admin, client) = setup_aggregated(&env, 2, 10, 1_000_000);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);
        client.add_reporter(&r1);
        client.add_reporter(&r2);
        client.add_reporter(&r3);

        // All three submit at ledger 1.
        submit_at(&env, &client, &r1, 1, 100);
        submit_at(&env, &client, &r2, 1, 200);
        submit_at(&env, &client, &r3, 1, 300);

        // Advance well past the staleness window (10), and only r1/r2 refresh.
        submit_at(&env, &client, &r1, 15, 100);
        submit_at(&env, &client, &r2, 15, 200);
        env.ledger().set_sequence_number(15);

        // If r3's stale 300 were still counted, the median of {100,200,300}
        // would be 200. With only {100,200} fresh, the median is their average.
        assert_eq!(client.get_price(), 150);
    }

    #[test]
    fn outlier_reporter_cannot_move_the_aggregated_price() {
        let env = Env::default();
        let (_admin, client) = setup_aggregated(&env, 3, 10, 1_000);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);
        let manipulator = Address::generate(&env);
        client.add_reporter(&r1);
        client.add_reporter(&r2);
        client.add_reporter(&r3);
        client.add_reporter(&manipulator);

        submit_at(&env, &client, &r1, 1, 100);
        submit_at(&env, &client, &r2, 1, 102);
        submit_at(&env, &client, &r3, 1, 102);
        // Wildly off from the rest — should be discarded as an outlier
        // (first-pass median is 102; 1_000 deviates far beyond 1_000 bps).
        submit_at(&env, &client, &manipulator, 1, 1_000);
        env.ledger().set_sequence_number(1);

        let price = client.get_price();
        assert_eq!(price, 102);
        assert_ne!(price, 1_000);
    }

    #[test]
    fn fewer_than_quorum_fresh_reports_fails_with_a_clear_error_not_a_stale_price() {
        let env = Env::default();
        let (_admin, client) = setup_aggregated(&env, 3, 10, 1_000_000);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        client.add_reporter(&r1);
        client.add_reporter(&r2);

        // Only 2 reporters exist at all; min_quorum is 3.
        submit_at(&env, &client, &r1, 1, 100);
        submit_at(&env, &client, &r2, 1, 100);
        env.ledger().set_sequence_number(1);

        let res = client.try_get_price();
        assert_eq!(res, Err(Ok(OracleError::QuorumNotMet)));
    }

    #[test]
    fn reporter_rotation_excludes_the_removed_reporter_going_forward() {
        let env = Env::default();
        let (_admin, client) = setup_aggregated(&env, 3, 10, 1_000_000);

        let r1 = Address::generate(&env);
        let r2 = Address::generate(&env);
        let r3 = Address::generate(&env);
        client.add_reporter(&r1);
        client.add_reporter(&r2);
        client.add_reporter(&r3);

        // r3's submission (100, matching r1) is chosen so that, if it were
        // wrongly still counted after removal, it would pull the median to a
        // different, distinguishable value than the correct one.
        submit_at(&env, &client, &r1, 1, 100);
        submit_at(&env, &client, &r2, 1, 500);
        submit_at(&env, &client, &r3, 1, 100);
        env.ledger().set_sequence_number(1);
        assert_eq!(client.get_price(), 100); // median of [100, 100, 500]

        // Rotate r3 out, r4 in; r3 is no longer authorized to submit at all.
        client.remove_reporter(&r3);
        let r4 = Address::generate(&env);
        client.add_reporter(&r4);
        let res = client.try_submit_price(&r3, &999);
        assert_eq!(res, Err(Ok(OracleError::Unauthorized)));

        // r4 submits fresh; r1/r2's ledger-1 submissions are still fresh too
        // (age 1, well within the staleness window of 10).
        submit_at(&env, &client, &r4, 2, 500);
        env.ledger().set_sequence_number(2);

        // Correct fresh set is {r1=100, r2=500, r4=500} -> median 500.
        // If r3's stale-but-stored 100 were wrongly still counted, the set
        // would be {100, 500, 100, 500} -> median (100+500)/2 = 300 instead.
        assert_eq!(client.get_price(), 500);
    }
}
