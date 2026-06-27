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

    /// Propose a new admin to take over the contract.
    ///
    /// Admin-only. This is the first step of a secure two-step admin
    /// transfer: the proposed admin is recorded but does not gain any
    /// authority until they explicitly call [`Self::accept_admin`]. Calling
    /// this again overwrites any previously proposed admin, allowing the
    /// current admin to correct a mistake before acceptance.
    pub fn propose_new_admin(env: Env, new_admin: Address) -> Result<(), RegistryError> {
        let admin = Self::read_admin(&env)?;
        admin.require_auth();

        env.storage()
            .instance()
            .set(&DataKey::ProposedAdmin, &new_admin);
        Self::bump_instance(&env);

        Ok(())
    }

    /// Accept a pending admin proposal, completing the two-step transfer.
    ///
    /// Can only be called by the address previously set via
    /// [`Self::propose_new_admin`]. On success the caller becomes the new
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

        Ok(())
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

    #[test]
    fn test_two_step_admin_transfer_flow() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let new_admin = Address::generate(&env);

        // Step 1: current admin proposes a new admin.
        client.propose_new_admin(&new_admin);

        // Step 2: proposed admin accepts the role.
        client.accept_admin();

        // The new admin can now perform admin-only actions.
        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[3u8; 32]);
        client.register_verification(&borrower, &report_hash, &100u32);
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

        // A non-admin signs the call, but the contract requires the current
        // admin's authorization, so the proposal is rejected.
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

        // Someone other than the proposed admin tries to accept the role.
        // The contract calls `proposed.require_auth()`, which the imposter's
        // signature does not satisfy, so the call panics.
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

        // The old admin signs, but it is no longer the admin, so the
        // `admin.require_auth()` inside `register_verification` (which now
        // checks `new_admin`) is not satisfied and the call panics.
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_verification",
                args: (borrower.clone(), report_hash.clone(), 100u32).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        client.register_verification(&borrower, &report_hash, &100u32);
    }

    #[test]
    fn test_proposal_can_be_overwritten_before_acceptance() {
        let env = Env::default();
        env.mock_all_auths();
        let (_admin, client) = setup(&env);

        let first_candidate = Address::generate(&env);
        let second_candidate = Address::generate(&env);

        // Admin proposes one address, then changes their mind.
        client.propose_new_admin(&first_candidate);
        client.propose_new_admin(&second_candidate);

        // The latest proposal is the one that takes effect on acceptance.
        client.accept_admin();

        let borrower = Address::generate(&env);
        let report_hash = BytesN::from_array(&env, &[6u8; 32]);
        client.register_verification(&borrower, &report_hash, &100u32);
        assert!(client.is_verified(&borrower));
    }
}
