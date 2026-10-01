// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

use crate::errors::BridgeError;

/// Message magic prefix: b"RMB\x01" (RemitMortgage Bridge v1).
pub const BRIDGE_MAGIC: [u8; 4] = [b'R', b'M', b'B', 0x01];

/// Current supported protocol version for inbound messages.
pub const CURRENT_VERSION: u8 = 1;

/// Maximum allowable extra data length to prevent memory exhaustion.
pub const MAX_EXTRA_DATA_LEN: usize = 64;

/// Minimum valid message size:
/// Magic (4) + Version (1) + PayloadType (1) + ChainId (4) + Nonce (8) + Amount (16) +
/// Sender (32) + Recipient (32) + ExtraDataLen (2) = 100 bytes.
pub const MIN_MESSAGE_LEN: usize = 100;

/// Action types supported in cross-chain bridge messages.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum MessagePayloadType {
    Lock = 1,
    Mint = 2,
    Burn = 3,
}

impl MessagePayloadType {
    pub fn from_u8(val: u8) -> Result<Self, BridgeError> {
        match val {
            1 => Ok(MessagePayloadType::Lock),
            2 => Ok(MessagePayloadType::Mint),
            3 => Ok(MessagePayloadType::Burn),
            _ => Err(BridgeError::MalformedPayload),
        }
    }
}

/// Parsed representation of an inbound cross-chain message envelope.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InboundBridgeMessage {
    pub version: u8,
    pub payload_type: MessagePayloadType,
    pub source_chain_id: u32,
    pub nonce: u64,
    pub amount: i128,
    pub sender: [u8; 32],
    pub recipient: [u8; 32],
    pub extra_data_len: usize,
    pub extra_data: [u8; 64],
}

impl InboundBridgeMessage {
    /// Serializes the inbound message into a binary wire format.
    /// Returns the number of bytes written, or MalformedPayload if buffer is too small.
    pub fn encode(&self, out: &mut [u8]) -> Result<usize, BridgeError> {
        let total_size = MIN_MESSAGE_LEN + self.extra_data_len;
        if out.len() < total_size || self.extra_data_len > MAX_EXTRA_DATA_LEN {
            return Err(BridgeError::MalformedPayload);
        }

        let mut offset = 0;

        // Magic (4 bytes)
        out[offset..offset + 4].copy_from_slice(&BRIDGE_MAGIC);
        offset += 4;

        // Version (1 byte)
        out[offset] = self.version;
        offset += 1;

        // Payload Type (1 byte)
        out[offset] = self.payload_type as u8;
        offset += 1;

        // Source Chain ID (4 bytes)
        out[offset..offset + 4].copy_from_slice(&self.source_chain_id.to_be_bytes());
        offset += 4;

        // Nonce (8 bytes)
        out[offset..offset + 8].copy_from_slice(&self.nonce.to_be_bytes());
        offset += 8;

        // Amount (16 bytes)
        out[offset..offset + 16].copy_from_slice(&self.amount.to_be_bytes());
        offset += 16;

        // Sender (32 bytes)
        out[offset..offset + 32].copy_from_slice(&self.sender);
        offset += 32;

        // Recipient (32 bytes)
        out[offset..offset + 32].copy_from_slice(&self.recipient);
        offset += 32;

        // Extra data length (2 bytes)
        let extra_len_u16 = self.extra_data_len as u16;
        out[offset..offset + 2].copy_from_slice(&extra_len_u16.to_be_bytes());
        offset += 2;

        // Extra data payload
        if self.extra_data_len > 0 {
            out[offset..offset + self.extra_data_len]
                .copy_from_slice(&self.extra_data[..self.extra_data_len]);
            offset += self.extra_data_len;
        }

        Ok(offset)
    }

    /// Safely parses an inbound cross-chain message payload without panicking.
    /// Validates field boundaries, numeric ranges, non-empty identifiers, and length limits.
    pub fn parse(raw: &[u8]) -> Result<Self, BridgeError> {
        // Guard against truncated header
        if raw.len() < MIN_MESSAGE_LEN {
            return Err(BridgeError::MalformedPayload);
        }

        // 1. Verify Magic prefix
        if raw[0..4] != BRIDGE_MAGIC {
            return Err(BridgeError::MalformedPayload);
        }

        // 2. Verify protocol version
        let version = raw[4];
        if version != CURRENT_VERSION {
            return Err(BridgeError::UnsupportedVersion);
        }

        // 3. Parse action/payload type
        let payload_type = MessagePayloadType::from_u8(raw[5])?;

        // 4. Source chain ID (must be non-zero)
        let source_chain_bytes: [u8; 4] = match raw[6..10].try_into() {
            Ok(b) => b,
            Err(_) => return Err(BridgeError::MalformedPayload),
        };
        let source_chain_id = u32::from_be_bytes(source_chain_bytes);
        if source_chain_id == 0 {
            return Err(BridgeError::UnsupportedChain);
        }

        // 5. Nonce
        let nonce_bytes: [u8; 8] = match raw[10..18].try_into() {
            Ok(b) => b,
            Err(_) => return Err(BridgeError::MalformedPayload),
        };
        let nonce = u64::from_be_bytes(nonce_bytes);

        // 6. Amount (must be strictly positive i128)
        let amount_bytes: [u8; 16] = match raw[18..34].try_into() {
            Ok(b) => b,
            Err(_) => return Err(BridgeError::MalformedPayload),
        };
        let amount = i128::from_be_bytes(amount_bytes);
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }

        // 7. Sender address
        let mut sender = [0u8; 32];
        sender.copy_from_slice(&raw[34..66]);

        // 8. Recipient address (must not be all zero)
        let mut recipient = [0u8; 32];
        recipient.copy_from_slice(&raw[66..98]);
        if recipient == [0u8; 32] {
            return Err(BridgeError::InvalidRecipient);
        }

        // 9. Extra data length
        let extra_len_bytes: [u8; 2] = match raw[98..100].try_into() {
            Ok(b) => b,
            Err(_) => return Err(BridgeError::MalformedPayload),
        };
        let extra_data_len = u16::from_be_bytes(extra_len_bytes) as usize;

        // Reject oversized variable fields
        if extra_data_len > MAX_EXTRA_DATA_LEN {
            return Err(BridgeError::MalformedPayload);
        }

        // Guard against truncated body payload
        if raw.len() < MIN_MESSAGE_LEN + extra_data_len {
            return Err(BridgeError::MalformedPayload);
        }

        let mut extra_data = [0u8; 64];
        if extra_data_len > 0 {
            extra_data[..extra_data_len].copy_from_slice(&raw[100..100 + extra_data_len]);
        }

        Ok(InboundBridgeMessage {
            version,
            payload_type,
            source_chain_id,
            nonce,
            amount,
            sender,
            recipient,
            extra_data_len,
            extra_data,
        })
    }
}
