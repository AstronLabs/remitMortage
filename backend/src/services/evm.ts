// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { ethers } from "ethers";

/**
 * Verify an EIP-191 personal_sign signature.
 *
 * ethers.verifyMessage prefixes the message with the standard Ethereum header
 * before recovering the signer address, matching the behaviour of MetaMask and
 * other EVM wallets when users call `personal_sign`.
 */
export function verifyEvmSignature(
  address: string,
  challenge: string,
  signature: string
): boolean {
  try {
    const recovered = ethers.verifyMessage(challenge, signature);
    return recovered.toLowerCase() === address.toLowerCase();
  } catch {
    return false;
  }
}
