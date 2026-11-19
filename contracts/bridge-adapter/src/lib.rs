// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Symbol, Vec};

mod errors;
pub mod message;
mod types;

/// Generic, interface-level compliance suite. Available to this crate's tests
/// and, via the `compliance-tests` feature, to other adapter crates.
#[cfg(any(test, feature = "compliance-tests"))]
pub mod compliance;

#[cfg(test)]
mod test;

#[cfg(test)]
mod fuzz_tests;

pub use crate::errors::BridgeError;
pub use crate::message::{InboundBridgeMessage, MessagePayloadType};
pub use crate::types::{
    AssetInfo, BridgeConfig, BridgeOperation, BridgeState, ChainVolumeWindow, PendingCapIncrease,
};

/// Rolling window length, in seconds, for the per-source-chain daily mint
/// volume cap (issue #858).
const DAILY_CAP_WINDOW_SECONDS: u64 = 86_400;

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
        if env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::Admin)
            .is_some()
        {
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
            config.supported_chains.remove(idx as u32);
        }
        env.storage().instance().set(&DataKey::Config, &config);
    }

    // ── Per-source-chain daily volume cap (issue #858) ──────────────────

    /// Set `source_chain`'s daily mint-volume cap (admin only). Setting an
    /// initial cap (from the uncapped default of 0) or lowering an existing
    /// one takes effect immediately — both reduce risk. Raising an existing
    /// positive cap is rejected here; use `propose_daily_cap_increase` /
    /// `execute_daily_cap_increase` instead, since only raises go through
    /// the timelock.
    pub fn set_daily_cap(
        env: Env,
        admin: Address,
        source_chain: Symbol,
        new_cap: i128,
    ) -> Result<(), BridgeError> {
        Self::require_admin(&env, &admin);
        admin.require_auth();

        if new_cap < 0 {
            return Err(BridgeError::InvalidAmount);
        }

        let current_cap = Self::read_daily_cap(&env, &source_chain);
        if current_cap > 0 && new_cap > current_cap {
            return Err(BridgeError::CapIncreaseRequiresTimelock);
        }

        env.storage()
            .instance()
            .set(&DataKey::DailyCap(source_chain.clone()), &new_cap);
        env.events()
            .publish((symbol_short!("cap_set"), source_chain), new_cap);
        Ok(())
    }

    /// Propose raising `source_chain`'s daily cap above its current value
    /// (admin only). Takes effect only after `execute_daily_cap_increase` is
    /// called once the configured `CapChangeDelay` (ledger count) has
    /// elapsed — see `set_cap_change_delay`. Returns the ledger sequence at
    /// which it becomes executable.
    pub fn propose_daily_cap_increase(
        env: Env,
        admin: Address,
        source_chain: Symbol,
        new_cap: i128,
    ) -> Result<u32, BridgeError> {
        Self::require_admin(&env, &admin);
        admin.require_auth();

        let current_cap = Self::read_daily_cap(&env, &source_chain);
        if new_cap <= current_cap {
            return Err(BridgeError::InvalidAmount);
        }

        let delay = Self::read_cap_change_delay(&env);
        let execute_after = env.ledger().sequence() + delay;
        let pending = PendingCapIncrease {
            new_cap,
            execute_after,
        };
        env.storage()
            .instance()
            .set(&DataKey::PendingCapIncrease(source_chain.clone()), &pending);
        env.events().publish(
            (symbol_short!("cap_prop"), source_chain),
            (new_cap, execute_after),
        );
        Ok(execute_after)
    }

    /// Executes a previously-proposed cap increase once its timelock has
    /// elapsed (admin only).
    pub fn execute_daily_cap_increase(
        env: Env,
        admin: Address,
        source_chain: Symbol,
    ) -> Result<(), BridgeError> {
        Self::require_admin(&env, &admin);
        admin.require_auth();

        let key = DataKey::PendingCapIncrease(source_chain.clone());
        let pending: PendingCapIncrease = env
            .storage()
            .instance()
            .get(&key)
            .ok_or(BridgeError::NoPendingCapIncrease)?;

        if env.ledger().sequence() < pending.execute_after {
            return Err(BridgeError::CapChangeTimelockActive);
        }

        env.storage()
            .instance()
            .set(&DataKey::DailyCap(source_chain.clone()), &pending.new_cap);
        env.storage().instance().remove(&key);
        env.events()
            .publish((symbol_short!("cap_upd"), source_chain), pending.new_cap);
        Ok(())
    }

    /// Configures how many ledgers a cap increase must wait before it can
    /// execute (admin only). Defaults to 0 (no delay) until set.
    pub fn set_cap_change_delay(env: Env, admin: Address, delay_ledgers: u32) {
        Self::require_admin(&env, &admin);
        admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::CapChangeDelay, &delay_ledgers);
    }

    /// Current daily mint-volume cap for `source_chain` (0 = uncapped).
    pub fn get_daily_cap(env: Env, source_chain: Symbol) -> i128 {
        Self::read_daily_cap(&env, &source_chain)
    }

    /// Current rolling volume window for `source_chain`.
    pub fn get_volume_window(env: Env, source_chain: Symbol) -> ChainVolumeWindow {
        Self::read_volume_window(&env, &source_chain)
    }

    /// Pending cap increase for `source_chain`, if any.
    pub fn get_pending_cap_increase(env: Env, source_chain: Symbol) -> Option<PendingCapIncrease> {
        env.storage()
            .instance()
            .get(&DataKey::PendingCapIncrease(source_chain))
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
        <Self as BridgeAdapter>::lock(&env, &from, amount, &destination_chain, &recipient)
    }

    /// Mint wrapped assets through the adapter interface.
    ///
    /// # Replay-protection invariant
    ///
    /// Each bridge operation can be minted **at most once**. The guard is the
    /// operation's stored `status`: `mint` rejects a `"completed"` operation
    /// with `AlreadyProcessed` *before* any other check that could be reached
    /// on a replay and *before* any state-mutating effect (daily-volume
    /// accounting, the `"completed"` status write, the `total_minted`
    /// counter). The status flip and those effects happen in the same call,
    /// so a message is either fully applied and marked, or not applied at
    /// all. Because the guard is keyed by the operation id alone, a replay
    /// that changes the amount, recipient or source chain is still rejected
    /// as `AlreadyProcessed`, and operations are independent of each other,
    /// so delivery order does not matter. Covered by the `replay_*` tests in
    /// `test.rs`.
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
        <Self as BridgeAdapter>::burn(&env, &from, amount, &destination_chain, &recipient)
    }

    /// Return aggregate operation counters and the current configuration.
    pub fn get_state(env: Env) -> BridgeState {
        <Self as BridgeAdapter>::get_state(&env)
    }

    /// Verify an operation's bridge-operator signature. Stub semantics: an
    /// operation counts as signed once it exists on-chain.
    pub fn verify_signature(env: Env, operation_id: Symbol, signature: Symbol) -> bool {
        <Self as BridgeAdapter>::verify_signature(&env, &operation_id, &signature)
    }

    /// Allocates the next unique operation id, encoded as a decimal `Symbol`
    /// (`"1"`, `"2"`, ...). Built without allocation so it works in `no_std`.
    fn next_operation_id(env: &Env) -> Symbol {
        let next = env
            .storage()
            .instance()
            .get::<_, u64>(&DataKey::NextOperationId)
            .unwrap_or(0)
            + 1;
        env.storage()
            .instance()
            .set(&DataKey::NextOperationId, &next);
        Self::symbol_from_u64(env, next)
    }

    fn add_counter(env: &Env, key: &DataKey, amount: i128) {
        let current = env.storage().instance().get::<_, i128>(key).unwrap_or(0);
        env.storage().instance().set(key, &(current + amount));
    }

    /// Encodes a `u64` as a decimal `Symbol` without allocating.
    fn symbol_from_u64(env: &Env, mut value: u64) -> Symbol {
        if value == 0 {
            return symbol_short!("op0");
        }
        let mut buf = [0u8; 20];
        let mut index = buf.len();
        while value > 0 {
            index -= 1;
            buf[index] = b'0' + (value % 10) as u8;
            value /= 10;
        }
        let text = core::str::from_utf8(&buf[index..]).unwrap_or("op");
        Symbol::new(env, text)
    }

    /// Internal helper to verify admin permissions.
    fn require_admin(env: &Env, admin: &Address) {
        let stored_admin = Self::get_admin(env);
        if admin != &stored_admin {
            panic!("not authorized");
        }
    }

    // ── Per-source-chain daily volume cap (issue #858) ──────────────────

    fn read_daily_cap(env: &Env, source_chain: &Symbol) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::DailyCap(source_chain.clone()))
            .unwrap_or(0)
    }

    fn read_volume_window(env: &Env, source_chain: &Symbol) -> ChainVolumeWindow {
        env.storage()
            .instance()
            .get(&DataKey::VolumeWindow(source_chain.clone()))
            .unwrap_or(ChainVolumeWindow {
                window_start: env.ledger().timestamp(),
                volume: 0,
            })
    }

    fn write_volume_window(env: &Env, source_chain: &Symbol, window: &ChainVolumeWindow) {
        env.storage()
            .instance()
            .set(&DataKey::VolumeWindow(source_chain.clone()), window);
    }

    fn read_cap_change_delay(env: &Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::CapChangeDelay)
            .unwrap_or(0)
    }

    /// Enforces and records `source_chain`'s rolling daily mint-volume cap.
    /// A cap of 0 (never configured) means uncapped. Rolls the window over
    /// (resets volume to 0) if `DAILY_CAP_WINDOW_SECONDS` has elapsed since
    /// it started. Emits a warning event the first time this mint pushes
    /// the window to or past 80% of the cap, and again at 100%; rejects —
    /// without recording any volume, so a rejected mint can be retried once
    /// there's room — a mint that would exceed the cap.
    fn check_and_record_volume(
        env: &Env,
        source_chain: &Symbol,
        amount: i128,
    ) -> Result<(), BridgeError> {
        let cap = Self::read_daily_cap(env, source_chain);
        if cap <= 0 {
            return Ok(());
        }

        let now = env.ledger().timestamp();
        let mut window = Self::read_volume_window(env, source_chain);

        if now >= window.window_start + DAILY_CAP_WINDOW_SECONDS {
            window = ChainVolumeWindow {
                window_start: now,
                volume: 0,
            };
        }

        let projected = window.volume.saturating_add(amount);

        if projected > cap {
            env.events().publish(
                (symbol_short!("cap_rej"), source_chain.clone()),
                (amount, window.volume, cap),
            );
            return Err(BridgeError::DailyVolumeCapExceeded);
        }

        let eighty_pct = cap.saturating_mul(80) / 100;
        if projected >= eighty_pct && window.volume < eighty_pct {
            env.events().publish(
                (symbol_short!("cap_warn"), source_chain.clone()),
                (projected, cap),
            );
        }
        if projected >= cap && window.volume < cap {
            env.events().publish(
                (symbol_short!("cap_full"), source_chain.clone()),
                (projected, cap),
            );
        }

        window.volume = projected;
        Self::write_volume_window(env, source_chain, &window);
        Ok(())
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
            source_chain: symbol_short!("stellar"),
            destination_chain: destination_chain.clone(),
            status: symbol_short!("locked"),
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

        // Replay guard (see the invariant on `StellarBridgeAdapter::mint`):
        // must stay ahead of every check and effect below.
        if operation.status == symbol_short!("completed") {
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

        // Issue #858: bound how much this call can mint attributing to
        // `source_chain` within the current rolling window. Checked last,
        // after every other validation, and before the operation is marked
        // completed — a cap rejection leaves the operation untouched (still
        // pending) so it can be retried once there's room.
        Self::check_and_record_volume(env, source_chain, amount)?;

        let mut updated_operation = operation;
        updated_operation.status = symbol_short!("completed");
        env.storage().persistent().set(
            &DataKey::Operation(operation_id.clone()),
            &updated_operation,
        );
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
            source_chain: symbol_short!("stellar"),
            destination_chain: destination_chain.clone(),
            status: symbol_short!("burned"),
            timestamp: env.ledger().timestamp(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Operation(operation_id.clone()), &operation);
        Self::add_counter(env, &DataKey::TotalBurned, amount);

        Ok(operation_id)
    }

    fn verify_signature(env: &Env, operation_id: &Symbol, _signature: &Symbol) -> bool {
        // Stub: an operation is "signed" once it exists on-chain. A real
        // adapter verifies the operator signature against its authorized key.
        env.storage()
            .persistent()
            .get::<_, BridgeOperation>(&DataKey::Operation(operation_id.clone()))
            .is_some()
    }

    fn get_state(env: &Env) -> BridgeState {
        let config = Self::get_config(env);
        BridgeState {
            config: config.clone(),
            total_locked: env
                .storage()
                .instance()
                .get(&DataKey::TotalLocked)
                .unwrap_or(0),
            total_minted: env
                .storage()
                .instance()
                .get(&DataKey::TotalMinted)
                .unwrap_or(0),
            total_burned: env
                .storage()
                .instance()
                .get(&DataKey::TotalBurned)
                .unwrap_or(0),
        }
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
    /// Per-source-chain daily mint volume cap (issue #858). Absent/0 means
    /// uncapped — existing deployments that never call `set_daily_cap` keep
    /// today's unconditional minting behavior.
    DailyCap(Symbol),
    /// Per-source-chain rolling volume window backing the cap above.
    VolumeWindow(Symbol),
    /// Per-source-chain proposed cap increase awaiting its timelock.
    PendingCapIncrease(Symbol),
    /// Ledger-count delay a cap increase must wait before it can execute.
    /// Defaults to 0 (no delay) until an admin configures one, mirroring
    /// every other propose/execute timelock in this workspace.
    CapChangeDelay,
}
