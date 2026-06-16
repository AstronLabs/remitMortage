#![no_std]

use soroban_sdk::{contract, contractimpl, Env};

/// Lending Pool Contract Skeleton
#[contract]
pub struct LendingPoolContract;

#[contractimpl]
impl LendingPoolContract {
    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::Env;

    #[test]
    fn test_version() {
        let env = Env::default();
        let contract_id = env.register(LendingPoolContract, ());
        let client = LendingPoolContractClient::new(&env, &contract_id);
        assert_eq!(client.version(), 1);
    }
}
