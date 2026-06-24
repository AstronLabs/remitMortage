#![no_std]

mod errors;
mod types;

use crate::errors::RegistryError;
use crate::types::{DataKey, VerificationRecord};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env};

const INSTANCE_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const INSTANCE_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

const PERSISTENT_BUMP_AMOUNT: u32 = 518_400; // ~30 days
const PERSISTENT_LIFETIME_THRESHOLD: u32 = 129_600; // ~7.5 days

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
            // Keep the anchor alive for as long as it is actively read.
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

        Ok(())
    }

    /// Anchor a borrower eligibility report hash on-chain.
    ///
    /// Admin-only. The record expires `duration_ledgers` after the current
    /// ledger; registering again for the same borrower overwrites the
    /// previous record.
    pub fn register_verification(
        env: Env,
        borrower: Address,
        report_hash: BytesN<32>,
        duration_ledgers: u32,
    ) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        if duration_ledgers == 0 {
            return Err(RegistryError::InvalidDuration);
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
            expiration_ledger: verified_ledger.saturating_add(duration_ledgers),
        };

        Self::set_record(&env, &borrower, &record);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Returns `true` if the borrower has a valid, non-expired verification
    /// record anchored on-chain, and `false` otherwise.
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

    /// Returns the contract version.
    pub fn version(_env: Env) -> u32 {
        1
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{Address, BytesN, Env};

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

        client.register_verification(&borrower, &report_hash, &1_000u32);

        assert!(client.is_verified(&borrower));

        let record = client.get_verification(&borrower);
        assert_eq!(record.borrower, borrower);
        assert_eq!(record.report_hash, report_hash);
        assert_eq!(record.expiration_ledger, record.verified_ledger + 1_000);
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
        client.register_verification(&borrower, &report_hash, &100u32);
        assert!(client.is_verified(&borrower));

        // Advance the ledger right up to the expiration boundary: still valid.
        env.ledger().set_sequence_number(start + 100);
        assert!(client.is_verified(&borrower));

        // One ledger past expiration: no longer valid.
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

        let result = client.try_register_verification(&borrower, &report_hash, &0u32);
        assert_eq!(result, Err(Ok(RegistryError::InvalidDuration)));
    }

    #[test]
    fn test_register_zero_hash_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let borrower = Address::generate(&env);
        let zero_hash = BytesN::from_array(&env, &[0u8; 32]);

        let result = client.try_register_verification(&borrower, &zero_hash, &100u32);
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

        let result = client.try_register_verification(&borrower, &report_hash, &100u32);
        assert_eq!(result, Err(Ok(RegistryError::NotInitialized)));
    }

    #[test]
    #[should_panic(expected = "HostError: Error(Auth, InvalidAction)")]
    fn test_register_requires_admin_auth() {
        let env = Env::default();
        let admin = Address::generate(&env);
        let contract_id = env.register(VerificationRegistryContract, ());
        let client = VerificationRegistryContractClient::new(&env, &contract_id);

        // Authorize initialization, then withdraw all authorizations so the
        // admin has not signed the subsequent call.
        env.mock_all_auths();
        client.initialize(&admin);
        env.set_auths(&[]);

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[1u8; 32]);

        // The admin never signed this call, so `require_auth` panics.
        client.register_verification(&borrower, &report_hash, &100u32);
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

        // Only the non-admin signs. The contract calls `admin.require_auth()`,
        // which is not satisfied, so the call fails with an authorization error.
        env.mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_verification",
                args: (borrower.clone(), report_hash.clone(), 100u32).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.register_verification(&borrower, &report_hash, &100u32);
    }
}
