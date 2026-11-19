// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Deterministic, checksum-valid Stellar account ids (G...) for fixtures.
 * Encoded locally (StrKey: version byte + 32-byte key + CRC16-XModem, base32)
 * so factories work in tests that mock `@stellar/stellar-sdk`.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION = 6 << 3;

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A valid-looking, unique-per-seed Stellar public key. */
export function stellarAddress(seed: number): string {
  const key = new Uint8Array(32);
  new DataView(key.buffer).setUint32(28, seed >>> 0);
  const payload = new Uint8Array(33);
  payload[0] = ED25519_PUBLIC_KEY_VERSION;
  payload.set(key, 1);
  const crc = crc16Xmodem(payload);
  const full = new Uint8Array(35);
  full.set(payload);
  full[33] = crc & 0xff;
  full[34] = crc >> 8;
  return base32(full);
}
