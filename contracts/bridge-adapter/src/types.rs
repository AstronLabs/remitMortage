use soroban_sdk::{contracttype, Address, Symbol, Vec};

/// Bridge configuration settings.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeConfig {
    /// Admin address with control over bridge settings.
    pub admin: Address,
    
    /// Minimum amount that can be locked.
    pub min_lock_amount: i128,
    
    /// Maximum amount that can be locked.
    pub max_lock_amount: i128,
    
    /// List of supported destination chains.
    pub supported_chains: Vec<Symbol>,
    
    /// Whether bridge operations are currently paused.
    pub paused: bool,
}

/// Bridge operation state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeOperation {
    /// Unique operation identifier.
    pub operation_id: Symbol,
    
    /// Address initiating the operation.
    pub from: Address,
    
    /// Recipient address on the target chain.
    pub to: Address,
    
    /// Amount being transferred.
    pub amount: i128,
    
    /// Source chain identifier.
    pub source_chain: Symbol,
    
    /// Destination chain identifier.
    pub destination_chain: Symbol,
    
    /// Current operation status.
    pub status: Symbol,
    
    /// Operation timestamp.
    pub timestamp: u64,
}

/// Bridge state information.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct BridgeState {
    /// Current bridge configuration.
    pub config: BridgeConfig,
    
    /// Total amount locked across all operations.
    pub total_locked: i128,
    
    /// Total amount minted across all operations.
    pub total_minted: i128,
    
    /// Total amount burned across all operations.
    pub total_burned: i128,
}

/// Asset information for cross-chain transfers.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AssetInfo {
    /// Asset identifier (e.g., token address or symbol).
    pub asset_id: Symbol,
    
    /// Asset name.
    pub name: Symbol,
    
    /// Asset symbol.
    pub symbol: Symbol,
    
    /// Number of decimals.
    pub decimals: u32,
    
    /// Whether the asset is native to the chain.
    pub is_native: bool,
}
