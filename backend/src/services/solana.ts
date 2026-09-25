// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * Verify a Solana Ed25519 signature produced by `signMessage` in Phantom or
 * any NaCl-compatible wallet. The signature and the public key are both
 * expected to be hex-encoded; the address is a Base58-encoded 32-byte key.
 */
export function verifySolanaSignature(
  address: string,
  challenge: string,
  signature: string
): boolean {
  try {
    const publicKeyBytes = bs58.decode(address);
    const messageBytes = new TextEncoder().encode(challenge);
    const sigBytes = Buffer.from(signature, "hex");
    return nacl.sign.detached.verify(messageBytes, sigBytes, publicKeyBytes);
  } catch {
    return false;
  }
}
