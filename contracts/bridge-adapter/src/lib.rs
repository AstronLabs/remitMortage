#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Symbol};

mod errors;
mod types;

#[cfg(test)]
mod test;

pub use crate::errors::BridgeError;
pub use crate::types::{BridgeConfig, BridgeOperation, BridgeState, AssetInfo};

/// Cross-chain bridge adapter interface for future EVM collateral support.
///
/// This trait defines the standard operations that any bridge integration must
/// implement to enable cross-chain asset locking/minting. External bridge
/// providers should implement this interface to enable their bridge protocol
/// to work with the RemitMortgage platform.
///
/// # Operations
///
/// - **Lock**: Lock assets on the source chain, generating a claim or receipt
/// - **Mint**: Mint wrapped assets on the destination chain after lock confirmation
/// - **Burn**: Burn wrapped assets on the destination chain to unlock original assets
///
/// # Implementation Requirements
///
/// Implementations must:
/// 1. Verify bridge operator signatures and permissions
/// 2. Track locked/unlocked asset states to prevent double-spending
/// 3. Emit bridge events for off-chain monitoring and reconciliation
/// 4. Implement time-based locks and security thresholds
/// 5. Support atomic operations where possible or implement idempotency
pub trait BridgeAdapter {
    /// Lock assets on the source chain.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from` - The address locking the assets
    /// * `amount` - The amount of assets to lock
    /// * `destination_chain` - The target chain identifier (e.g., "ethereum", "polygon")
    /// * `recipient` - The recipient address on the destination chain
    ///
    /// # Returns
    /// A unique bridge operation ID that can be used to track the lock operation
    ///
    /// # Errors
    /// Returns `BridgeError` if:
    /// - Insufficient balance
    /// - Invalid destination chain
    /// - Invalid recipient address
    /// - Bridge is paused or in maintenance mode
    fn lock(
        env: &Env,
        from: &Address,
        amount: i128,
        destination_chain: &Symbol,
        recipient: &Address,
    ) -> Result<Symbol, BridgeError>;

    /// Mint wrapped assets on the destination chain after lock confirmation.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `operation_id` - The bridge operation ID from the lock operation
    /// * `to` - The address to receive the minted assets
    /// * `amount` - The amount of assets to mint
    /// * `source_chain` - The source chain identifier
    ///
    /// # Returns
    /// Success if minting completed successfully
    ///
    /// # Errors
    /// Returns `BridgeError` if:
    /// - Operation ID not found or already processed
    /// - Signature verification fails
    /// - Amount mismatch with original lock
    /// - Bridge is paused
    fn mint(
        env: &Env,
        operation_id: &Symbol,
        to: &Address,
        amount: i128,
        source_chain: &Symbol,
    ) -> Result<(), BridgeError>;

    /// Burn wrapped assets on the destination chain to unlock original assets.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `from` - The address burning the wrapped assets
    /// * `amount` - The amount of assets to burn
    /// * `destination_chain` - The target chain for unlocking (source chain)
    /// * `recipient` - The recipient address on the source chain
    ///
    /// # Returns
    /// A unique bridge operation ID for tracking the unlock operation
    ///
    /// # Errors
    /// Returns `BridgeError` if:
    /// - Insufficient wrapped asset balance
    /// - Invalid destination chain
    /// - Invalid recipient address
    /// - Bridge is paused
    fn burn(
        env: &Env,
        from: &Address,
        amount: i128,
        destination_chain: &Symbol,
        recipient: &Address,
    ) -> Result<Symbol, BridgeError>;

    /// Verify bridge operator signature for an operation.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `operation_id` - The bridge operation ID
    /// * `signature` - The operator signature to verify
    ///
    /// # Returns
    /// True if signature is valid and from an authorized operator
    fn verify_signature(env: &Env, operation_id: &Symbol, signature: &Symbol) -> bool;

    /// Get the current bridge state and configuration.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    ///
    /// # Returns
    /// Current bridge configuration and state
    fn get_state(env: &Env) -> BridgeState;
}

/// Stellar-side stub implementation of the BridgeAdapter interface.
///
/// This is a reference implementation for testing and development. In production,
/// this would be replaced by a real bridge integration (e.g., Axelar, Wormhole,
/// LayerZero, or a custom bridge implementation).
#[contract]
pub struct StellarBridgeAdapter;

#[contractimpl]
impl StellarBridgeAdapter {
    /// Initialize the bridge adapter with configuration.
    ///
    /// # Arguments
    /// * `env` - The Soroban environment
    /// * `admin` - The admin address with control over bridge settings
    /// * `min_lock_amount` - Minimum amount that can be locked
    /// * `max_lock_amount` - Maximum amount that can be locked
    /// * `supported_chains` - List of supported destination chains
    pub fn initialize(
        env: &Env,
        admin: Address,
        min_lock_amount: i128,
        max_lock_amount: i128,
        supported_chains: Vec<Symbol>,
    ) {
        if env.storage().instance().get(&DataKey::Admin).is_some() {
            panic!("already initialized");
        }

        let config = BridgeConfig {
            admin: admin.clone(),
            min_lock_amount,
            max_lock_amount,
            supported_chains,
            paused: false,
        };

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// Pause bridge operations (admin only).
    pub fn pause(env: &Env, admin: Address) {
        Self::require_admin(env, &admin);
        let mut config = Self::get_config(env);
        config.paused = true;
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// Resume bridge operations (admin only).
    pub fn unpause(env: &Env, admin: Address) {
        Self::require_admin(env, &admin);
        let mut config = Self::get_config(env);
        config.paused = false;
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// Add a supported chain (admin only).
    pub fn add_supported_chain(env: &Env, admin: Address, chain: Symbol) {
        Self::require_admin(env, &admin);
        let mut config = Self::get_config(env);
        if !config.supported_chains.contains(&chain) {
            config.supported_chains.push_back(chain);
        }
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// Remove a supported chain (admin only).
    pub fn remove_supported_chain(env: &Env, admin: Address, chain: Symbol) {
        Self::require_admin(env, &admin);
        let mut config = Self::get_config(env);
        let index = config.supported_chains.iter().position(|c| c == chain);
        if let Some(idx) = index {
            config.supported_chains.remove(idx);
        }
        env.storage().instance().set(&DataKey::Config, &config);
    }

    /// Get the current bridge configuration.
    pub fn get_config(env: &Env) -> BridgeConfig {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Get the admin address.
    pub fn get_admin(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic!("not initialized"))
    }

    /// Lock assets through the adapter interface.
    pub fn lock(
        env: Env,
        from: Address,
        amount: i128,
        destination_chain: Symbol,
        recipient: Address,
    ) -> Result<Symbol, BridgeError> {
        <Self as BridgeAdapter>::lock(
            &env,
            &from,
            amount,
            &destination_chain,
            &recipient,
        )
    }

    /// Mint wrapped assets through the adapter interface.
    pub fn mint(
        env: Env,
        operation_id: Symbol,
        to: Address,
        amount: i128,
        source_chain: Symbol,
    ) -> Result<(), BridgeError> {
        <Self as BridgeAdapter>::mint(&env, &operation_id, &to, amount, &source_chain)
    }

    /// Burn wrapped assets through the adapter interface.
    pub fn burn(
        env: Env,
        from: Address,
        amount: i128,
        destination_chain: Symbol,
        recipient: Address,
    ) -> Result<Symbol, BridgeError> {
        <Self as BridgeAdapter>::burn(
            &env,
            &from,
            amount,
            &destination_chain,
            &recipient,
        )
    }

    /// Return aggregate operation counters and the current configuration.
    pub fn get_state(env: Env) -> BridgeState {
        <Self as BridgeAdapter>::get_state(&env)
    }

    /// Internal helper to verify admin permissions.
    fn require_admin(env: &Env, admin: &Address) {
        let stored_admin = Self::get_admin(env);
        if admin != &stored_admin {
            panic!("not authorized");
        }
    }
}

/// Implementation of BridgeAdapter trait for StellarBridgeAdapter.
impl BridgeAdapter for StellarBridgeAdapter {
    fn lock(
        env: &Env,
        from: &Address,
        amount: i128,
        destination_chain: &Symbol,
        recipient: &Address,
    ) -> Result<Symbol, BridgeError> {
        let config = Self::get_config(env);
        
        if config.paused {
            return Err(BridgeError::BridgePaused);
        }

        if amount < config.min_lock_amount || amount > config.max_lock_amount {
            return Err(BridgeError::InvalidAmount);
        }

        if !config.supported_chains.contains(destination_chain) {
            return Err(BridgeError::UnsupportedChain);
        }

        let operation_id = Self::next_operation_id(env);

        // Store operation state
        let operation = BridgeOperation {
            operation_id: operation_id.clone(),
            from: from.clone(),
            to: recipient.clone(),
            amount,
            source_chain: Symbol::short(b"stellar"),
            destination_chain: destination_chain.clone(),
            status: Symbol::short(b"locked"),
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(operation_id.clone()), &operation);
        Self::add_counter(env, &DataKey::TotalLocked, amount);

        Ok(operation_id)
    }

    fn mint(
        env: &Env,
        operation_id: &Symbol,
        to: &Address,
        amount: i128,
        source_chain: &Symbol,
    ) -> Result<(), BridgeError> {
        let config = Self::get_config(env);
        
        if config.paused {
            return Err(BridgeError::BridgePaused);
        }

        let operation = env
            .storage()
            .persistent()
            .get::<_, BridgeOperation>(&DataKey::Operation(operation_id.clone()))
            .ok_or(BridgeError::OperationNotFound)?;

        if operation.status == Symbol::short(b"completed") {
            return Err(BridgeError::AlreadyProcessed);
        }

        if operation.amount != amount {
            return Err(BridgeError::AmountMismatch);
        }

        if operation.source_chain != *source_chain {
            return Err(BridgeError::ChainMismatch);
        }

        if operation.to != *to {
            return Err(BridgeError::InvalidRecipient);
        }

        let mut updated_operation = operation;
        updated_operation.status = Symbol::short(b"completed");
        env.storage()
            .persistent()
            .set(&DataKey::Operation(operation_id.clone()), &updated_operation);
        Self::add_counter(env, &DataKey::TotalMinted, amount);

        Ok(())
    }

    fn burn(
        env: &Env,
        from: &Address,
        amount: i128,
        destination_chain: &Symbol,
        recipient: &Address,
    ) -> Result<Symbol, BridgeError> {
        let config = Self::get_config(env);
        
        if config.paused {
            return Err(BridgeError::BridgePaused);
        }

        if amount < config.min_lock_amount || amount > config.max_lock_amount {
            return Err(BridgeError::InvalidAmount);
        }

        if !config.supported_chains.contains(destination_chain) {
            return Err(BridgeError::UnsupportedChain);
        }

        let operation_id = Self::next_operation_id(env);

        // Store operation state
        let operation = BridgeOperation {
            operation_id: operation_id.clone(),
            from: from.clone(),
            to: recipient.clone(),
            amount,
            source_chain: Symbol::short(b"stellar"),
            destination_chain: destination_chain.clone(),
            status: Symbol::short(b"burned"),
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(operation_id.clone()), &operation);
        Self::add_counter(env, &DataKey::TotalBurned, amount);

        Ok(operation_id)
    }

    fn verify_signature(env: &Env, operation_id: &Symbol, signature: &Symbol) -> bool {
        let operation_exists = env
            .storage()
            .persistent()
            .get::<_, BridgeOperation>(&DataKey::Operation(operation_id.clone()));

        operation_exists.is_some() && !signature.to_string().is_empty()
    }

    fn get_state(env: &Env) -> BridgeState {
        let config = Self::get_config(env);
        BridgeState {
            config: config.clone(),
            total_locked: env.storage().instance().get(&DataKey::TotalLocked).unwrap_or(0),
            total_minted: env.storage().instance().get(&DataKey::TotalMinted).unwrap_or(0),
            total_burned: env.storage().instance().get(&DataKey::TotalBurned).unwrap_or(0),
        }
    }

    fn next_operation_id(env: &Env) -> Symbol {
        let next = env
            .storage()
            .instance()
            .get::<_, u64>(&DataKey::NextOperationId)
            .unwrap_or(0)
            + 1;
        env.storage().instance().set(&DataKey::NextOperationId, &next);
        next.into()
    }

    fn add_counter(env: &Env, key: &DataKey, amount: i128) {
        let current = env.storage().instance().get::<_, i128>(key).unwrap_or(0);
        env.storage().instance().set(key, &(current + amount));
    }
}

/// Storage keys for the bridge adapter.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Config,
    Operation(Symbol),
    AssetInfo(Symbol),
    NextOperationId,
    TotalLocked,
    TotalMinted,
    TotalBurned,
}
