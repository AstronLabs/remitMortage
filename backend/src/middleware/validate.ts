import { Request, Response, NextFunction } from "express";
import { StrKey } from "@stellar/stellar-sdk";

export type Network = "stellar" | "ethereum" | "solana";

function isValidGAddress(addr: unknown): boolean {
  if (typeof addr !== "string") return false;
  if (addr.length !== 56) return false;
  if (!addr.startsWith("G")) return false;
  try {
    // Throws if invalid
    StrKey.decodeEd25519PublicKey(addr);
    return true;
  } catch (err) {
    return false;
  }
}

export function validateVerificationBody(req: Request, res: Response, next: NextFunction) {
  const { senderAddress, recipientAddress } = req.body ?? {};

  if (!senderAddress) {
    return res.status(400).json({ error: "missing_field", field: "senderAddress", message: "senderAddress is required" });
  }

  if (!recipientAddress) {
    return res.status(400).json({ error: "missing_field", field: "recipientAddress", message: "recipientAddress is required" });
  }

  if (!isValidGAddress(senderAddress)) {
    return res.status(400).json({ error: "invalid_address", field: "senderAddress", message: "Invalid Stellar G-address" });
  }

  if (!isValidGAddress(recipientAddress)) {
    return res.status(400).json({ error: "invalid_address", field: "recipientAddress", message: "Invalid Stellar G-address" });
  }

  return next();
}

export function validateWalletAddress(req: Request, res: Response, next: NextFunction) {
  const { walletAddress } = req.body ?? {};
  if (!walletAddress) {
    return res.status(400).json({ error: "missing_field", field: "walletAddress", message: "walletAddress is required" });
  }
  if (!isValidGAddress(walletAddress)) {
    return res.status(400).json({ error: "invalid_address", field: "walletAddress", message: "Invalid Stellar G-address" });
  }
  return next();
}

export function validateBorrowerParams(req: Request, res: Response, next: NextFunction) {
  const { address } = req.params ?? {};

  if (!address) {
    return res.status(400).json({ error: "missing_field", field: "address", message: "address parameter is required" });
  }

  if (!isValidGAddress(address)) {
    return res.status(400).json({ error: "invalid_address", field: "address", message: "Invalid Stellar G-address" });
  }

  return next();
}

function isValidEvmAddress(addr: unknown): boolean {
  if (typeof addr !== "string") return false;
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

// Base58 character set; Solana public keys decode to exactly 32 bytes (43-44 chars).
function isValidSolanaAddress(addr: unknown): boolean {
  if (typeof addr !== "string") return false;
  if (addr.length < 32 || addr.length > 44) return false;
  return /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr);
}

function isValidAddressForNetwork(addr: unknown, network: Network): boolean {
  switch (network) {
    case "stellar":
      return isValidGAddress(addr);
    case "ethereum":
      return isValidEvmAddress(addr);
    case "solana":
      return isValidSolanaAddress(addr);
  }
}

const VALID_NETWORKS: Network[] = ["stellar", "ethereum", "solana"];

/**
 * Validates `walletAddress` and `network` for multi-chain ownership endpoints.
 * The existing Stellar-only `validateWalletAddress` is kept for backward compat.
 */
export function validateMultiChainOwnership(req: Request, res: Response, next: NextFunction) {
  const { walletAddress, network } = req.body ?? {};

  if (!walletAddress) {
    return res.status(400).json({ error: "missing_field", field: "walletAddress", message: "walletAddress is required" });
  }
  if (!network) {
    return res.status(400).json({ error: "missing_field", field: "network", message: "network is required (stellar | ethereum | solana)" });
  }
  if (!VALID_NETWORKS.includes(network as Network)) {
    return res.status(400).json({ error: "invalid_network", message: "network must be one of: stellar, ethereum, solana" });
  }
  if (!isValidAddressForNetwork(walletAddress, network as Network)) {
    return res.status(400).json({ error: "invalid_address", field: "walletAddress", message: `Invalid ${network} address` });
  }

  return next();
}

export function validatePositiveNumber(fieldName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const val = req.body?.[fieldName];
    const num = Number(val);
    if (val === undefined || val === null || Number.isNaN(num) || num <= 0) {
      return res.status(400).json({ error: "invalid_number", field: fieldName, message: `${fieldName} must be a positive number` });
    }
    return next();
  };
}

/**
 * When the request body contains a `guarantorAddress` field, validates that it
 * is a syntactically correct Stellar G-address.  Requests without the field
 * pass through unchanged so existing borrower-only loans are unaffected.
 *
 * Does NOT verify the guarantor signature — that is done in the route handler
 * after the address is known to be syntactically valid.
 */
export function validateOptionalGuarantorAddress(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const { guarantorAddress } = req.body ?? {};
  if (guarantorAddress === undefined || guarantorAddress === null) {
    return next(); // no guarantor — allowed
  }
  if (!isValidGAddress(guarantorAddress)) {
    return res.status(400).json({
      error: "invalid_address",
      field: "guarantorAddress",
      message: "guarantorAddress must be a valid Stellar G-address",
    });
  }
  return next();
}
