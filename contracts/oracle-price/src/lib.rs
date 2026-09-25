// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Price,
    Observations,
    DeviationConfig,
    HaltFlag,
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

#[contract]
pub struct OraclePriceContract;

impl OraclePriceContract {
    fn read_observations(env: &Env) -> Vec<PriceData> {
        env.storage()
            .instance()
            .get(&DataKey::Observations)
            .unwrap_or_else(|| Vec::new(env))
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
            if observations.len() > 0 {
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
            if current_ledger <= last_price.updated_ledger + conf.window_ledgers {
                if last_price.price > 0 {
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

    pub fn get_price(env: Env) -> i128 {
        let halt_flag: bool = env
            .storage()
            .instance()
            .get(&DataKey::HaltFlag)
            .unwrap_or(false);
        if halt_flag {
            panic!("Oracle halted");
        }
        Self::twap_price(&env)
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
}
