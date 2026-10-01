// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Proptest fuzz testing suite for bridge adapter inbound message parsing.
//!
//! Exercises parser resilience against malformed, truncated, oversized,
//! and adversarially crafted payloads without panicking or undefined state.

#![cfg(test)]
extern crate std;

use std::vec::Vec;
use crate::{
    message::{
        InboundBridgeMessage, MessagePayloadType, BRIDGE_MAGIC, CURRENT_VERSION,
        MAX_EXTRA_DATA_LEN, MIN_MESSAGE_LEN,
    },
    BridgeError,
};
use proptest::prelude::*;

prop_compose! {
    /// Strategy generating arbitrary valid message structures.
    fn valid_message_strategy()(
        payload_type_u8 in 1u8..=3u8,
        source_chain_id in 1u32..=100_000u32,
        nonce in any::<u64>(),
        amount in 1i128..=i128::MAX,
        sender in prop::array::uniform32(any::<u8>()),
        recipient in prop::array::uniform32(1u8..=255u8), // non-zero
        extra_len in 0usize..=MAX_EXTRA_DATA_LEN,
        extra_data in prop::array::uniform64(any::<u8>()),
    ) -> InboundBridgeMessage {
        InboundBridgeMessage {
            version: CURRENT_VERSION,
            payload_type: MessagePayloadType::from_u8(payload_type_u8).unwrap(),
            source_chain_id,
            nonce,
            amount,
            sender,
            recipient,
            extra_data_len: extra_len,
            extra_data,
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// 1. Arbitrary Raw Byte Fuzzing:
    /// Feeds completely random and adversarial byte sequences (0..2048 bytes) into the parser.
    /// Invariant: The parser must NEVER panic and either returns Ok or cleanly returns BridgeError.
    #[test]
    fn fuzz_parser_never_panics_on_arbitrary_bytes(raw in prop::collection::vec(any::<u8>(), 0..2048)) {
        let res = InboundBridgeMessage::parse(&raw);
        match res {
            Ok(msg) => {
                // If it succeeded, all invariants must hold
                prop_assert_eq!(msg.version, CURRENT_VERSION);
                prop_assert!(msg.amount > 0);
                prop_assert!(msg.source_chain_id > 0);
                prop_assert_ne!(msg.recipient, [0u8; 32]);
                prop_assert!(msg.extra_data_len <= MAX_EXTRA_DATA_LEN);
            }
            Err(err) => {
                // Legitimate clean error rejection
                prop_assert!(matches!(
                    err,
                    BridgeError::MalformedPayload
                        | BridgeError::UnsupportedVersion
                        | BridgeError::UnsupportedChain
                        | BridgeError::InvalidAmount
                        | BridgeError::InvalidRecipient
                ));
            }
        }
    }

    /// 2. Truncation Fuzzing:
    /// Takes a validly constructed message and slices it short of its required length.
    /// Invariant: Truncated payloads must be cleanly rejected with an error, never panic.
    #[test]
    fn fuzz_truncated_payloads_cleanly_rejected(
        msg in valid_message_strategy(),
        truncation_offset in 0usize..MIN_MESSAGE_LEN,
    ) {
        let mut buf = [0u8; 256];
        let encoded_len = msg.encode(&mut buf).expect("encoding valid message should succeed");
        
        let target_len = truncation_offset.min(encoded_len.saturating_sub(1));
        let truncated = &buf[..target_len];

        let res = InboundBridgeMessage::parse(truncated);
        prop_assert!(res.is_err(), "Truncated payload of length {} should be rejected", target_len);
    }

    /// 3. Oversized & Out-of-bounds Field Fuzzing:
    /// Generates messages where extra_data_len claims more bytes than permitted or available.
    /// Invariant: Rejection with MalformedPayload without buffer overflow or indexing panic.
    #[test]
    fn fuzz_oversized_field_lengths(
        msg in valid_message_strategy(),
        declared_len in (MAX_EXTRA_DATA_LEN + 1)..=u16::MAX as usize,
    ) {
        let mut buf = [0u8; 512];
        let _ = msg.encode(&mut buf);

        // Corrupt extra_data_len field at offset 98..100
        let len_bytes = (declared_len as u16).to_be_bytes();
        buf[98] = len_bytes[0];
        buf[99] = len_bytes[1];

        let res = InboundBridgeMessage::parse(&buf[..MIN_MESSAGE_LEN]);
        prop_assert_eq!(res, Err(BridgeError::MalformedPayload));
    }

    /// 4. Boundary Numeric Values Fuzzing:
    /// Evaluates numeric boundaries for amounts (i128::MIN, negative values, 0, i128::MAX).
    /// Invariant: Non-positive amounts must return InvalidAmount, valid positive amounts parse correctly.
    #[test]
    fn fuzz_boundary_numeric_values(
        msg in valid_message_strategy(),
        test_amount in prop_oneof![
            Just(i128::MIN),
            Just(i128::MIN + 1),
            -1_000_000_000i128..=-1i128,
            Just(0i128),
            Just(1i128),
            1_000_000i128..=1_000_000_000i128,
            Just(i128::MAX - 1),
            Just(i128::MAX),
        ]
    ) {
        let mut mutated = msg;
        mutated.amount = test_amount;

        let mut buf = [0u8; 256];
        let encoded_len = mutated.encode(&mut buf).expect("encode should succeed");

        let res = InboundBridgeMessage::parse(&buf[..encoded_len]);
        if test_amount <= 0 {
            prop_assert_eq!(res, Err(BridgeError::InvalidAmount));
        } else {
            prop_assert!(res.is_ok());
            prop_assert_eq!(res.unwrap().amount, test_amount);
        }
    }

    /// 5. Invalid Encoding / Corrupted Magic & Version Fuzzing:
    /// Invariant: Corrupted magic prefix or unknown version must be rejected without panic.
    #[test]
    fn fuzz_corrupted_magic_and_version(
        msg in valid_message_strategy(),
        corrupted_magic in prop::array::uniform4(any::<u8>()),
        corrupted_version in 2u8..=u8::MAX,
    ) {
        let mut buf = [0u8; 256];
        let len = msg.encode(&mut buf).unwrap();

        // Corrupt magic if not accidentally equal
        if corrupted_magic != BRIDGE_MAGIC {
            buf[0..4].copy_from_slice(&corrupted_magic);
            let res = InboundBridgeMessage::parse(&buf[..len]);
            prop_assert_eq!(res, Err(BridgeError::MalformedPayload));
        }

        // Restore magic and corrupt version
        buf[0..4].copy_from_slice(&BRIDGE_MAGIC);
        buf[4] = corrupted_version;
        let res_ver = InboundBridgeMessage::parse(&buf[..len]);
        prop_assert_eq!(res_ver, Err(BridgeError::UnsupportedVersion));
    }

    /// 6. Roundtrip Encoding / Decoding Property:
    /// Invariant: Any valid message serialized with encode must cleanly decode back to itself.
    #[test]
    fn fuzz_roundtrip_valid_messages(msg in valid_message_strategy()) {
        let mut buf = [0u8; 256];
        let len = msg.encode(&mut buf).expect("Encoding valid message must succeed");
        let parsed = InboundBridgeMessage::parse(&buf[..len]).expect("Parsing encoded message must succeed");

        prop_assert_eq!(parsed.version, msg.version);
        prop_assert_eq!(parsed.payload_type, msg.payload_type);
        prop_assert_eq!(parsed.source_chain_id, msg.source_chain_id);
        prop_assert_eq!(parsed.nonce, msg.nonce);
        prop_assert_eq!(parsed.amount, msg.amount);
        prop_assert_eq!(parsed.sender, msg.sender);
        prop_assert_eq!(parsed.recipient, msg.recipient);
        prop_assert_eq!(parsed.extra_data_len, msg.extra_data_len);
        prop_assert_eq!(&parsed.extra_data[..parsed.extra_data_len], &msg.extra_data[..msg.extra_data_len]);
    }
}
