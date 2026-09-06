use soroban_sdk::contracterror;

/// Bridge adapter errors.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum BridgeError {
    /// Bridge is paused and operations are not allowed.
    BridgePaused = 1,
    
    /// Amount is outside the allowed range (min/max).
    InvalidAmount = 2,
    
    /// Destination chain is not supported.
    UnsupportedChain = 3,
    
    /// Operation not found.
    OperationNotFound = 4,
    
    /// Operation has already been processed.
    AlreadyProcessed = 5,
    
    /// Amount mismatch between operations.
    AmountMismatch = 6,
    
    /// Chain identifier mismatch.
    ChainMismatch = 7,
    
    /// Invalid recipient address.
    InvalidRecipient = 8,
    
    /// Insufficient balance for operation.
    InsufficientBalance = 9,
    
    /// Signature verification failed.
    InvalidSignature = 10,
    
    /// Bridge is not initialized.
    NotInitialized = 11,
    
    /// Unauthorized access (not admin).
    Unauthorized = 12,
    
    /// Operation timeout.
    OperationTimeout = 13,
    
    /// Invalid asset identifier.
    InvalidAsset = 14,
}
