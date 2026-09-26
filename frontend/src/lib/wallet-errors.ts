// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Networks } from "@stellar/stellar-sdk";

/**
 * Wallet failure taxonomy.
 *
 * Freighter surfaces failures as thrown errors or as `{ error }` payloads whose
 * shape differs between extension versions, so everything funnels through
 * `classifyWalletError` and comes back as one of these kinds.
 */
export type WalletErrorKind =
  | "rejected"
  | "network_mismatch"
  | "not_installed"
  | "locked"
  | "disconnected"
  | "unknown";

export type WalletError = {
  kind: WalletErrorKind;
  /** Copy shown to the user. */
  message: string;
  /** Whether retrying the same action can plausibly succeed. */
  recoverable: boolean;
  /** Original message, kept for logs and the diagnostics panel. */
  detail?: string;
};

/** User-facing copy per failure kind. */
export const WALLET_ERROR_MESSAGES: Record<WalletErrorKind, string> = {
  rejected: "Transaction rejected by user.",
  network_mismatch:
    "Freighter is on the wrong network. Switch it to the network this app is configured for and try again.",
  not_installed:
    "Freighter was not detected. Install the extension, then reload this page.",
  locked: "Freighter is locked. Unlock the extension and try again.",
  disconnected:
    "Wallet disconnected. Reconnect Freighter to continue.",
  unknown: "The wallet could not complete this request.",
};

const REJECTION_PATTERNS = [
  /user declined/i,
  /user rejected/i,
  /user denied/i,
  /request(ed)? (was )?(declined|rejected|denied)/i,
  /declined access/i,
  /rejected by (the )?user/i,
  /operation cancelled/i,
];

const NETWORK_PATTERNS = [
  /network mismatch/i,
  /wrong network/i,
  /different network/i,
  /network passphrase/i,
  /networkpassphrase does not match/i,
];

const NOT_INSTALLED_PATTERNS = [
  /not available/i,
  /not detected/i,
  /not installed/i,
  /freighter is not/i,
  /no wallet/i,
  /signing api is unavailable/i,
];

const LOCKED_PATTERNS = [/locked/i, /unlock/i, /enter your password/i];

const DISCONNECTED_PATTERNS = [
  /not allowed/i,
  /disconnected/i,
  /no public key/i,
  /could not get public key/i,
  /account not found in wallet/i,
];

/** Wallet-side rejection codes seen across Freighter and EIP-1193 providers. */
const REJECTION_CODES = new Set([4001, -4, -32603]);

function readMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; error?: unknown };
    if (typeof candidate.message === "string") return candidate.message;
    if (typeof candidate.error === "string") return candidate.error;
    if (candidate.error && typeof candidate.error === "object") {
      const nested = candidate.error as { message?: unknown };
      if (typeof nested.message === "string") return nested.message;
    }
  }
  return "";
}

function readCode(error: unknown): number | null {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; error?: { code?: unknown } };
    if (typeof candidate.code === "number") return candidate.code;
    if (candidate.error && typeof candidate.error === "object") {
      const nested = candidate.error as { code?: unknown };
      if (typeof nested.code === "number") return nested.code;
    }
  }
  return null;
}

function matches(patterns: RegExp[], message: string): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

/**
 * Map any wallet failure onto a `WalletError` with copy the UI can render
 * directly. Unrecognised failures fall back to `unknown` and keep the original
 * message as `detail` so nothing is lost.
 */
export function classifyWalletError(error: unknown): WalletError {
  const detail = readMessage(error).trim();
  const code = readCode(error);

  if (code !== null && REJECTION_CODES.has(code)) {
    return build("rejected", detail, false);
  }
  if (matches(REJECTION_PATTERNS, detail)) {
    return build("rejected", detail, false);
  }
  if (matches(NETWORK_PATTERNS, detail)) {
    return build("network_mismatch", detail, false);
  }
  if (matches(NOT_INSTALLED_PATTERNS, detail)) {
    return build("not_installed", detail, false);
  }
  if (matches(LOCKED_PATTERNS, detail)) {
    return build("locked", detail, true);
  }
  if (matches(DISCONNECTED_PATTERNS, detail)) {
    return build("disconnected", detail, true);
  }

  return build("unknown", detail, true);
}

function build(kind: WalletErrorKind, detail: string, recoverable: boolean): WalletError {
  return {
    kind,
    message: WALLET_ERROR_MESSAGES[kind],
    recoverable,
    detail: detail || undefined,
  };
}

/** True when the failure was the user declining in their wallet. */
export function isUserRejection(error: unknown): boolean {
  return classifyWalletError(error).kind === "rejected";
}

/**
 * The network this app expects Freighter to be on, derived from the configured
 * network passphrase.
 */
export function getExpectedNetwork(): string {
  const passphrase = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;
  if (passphrase === Networks.PUBLIC) return "PUBLIC";
  if (passphrase === Networks.FUTURENET) return "FUTURENET";
  return "TESTNET";
}

/**
 * Compare the network reported by Freighter against the expected one.
 * An unknown/absent network is not treated as a mismatch — we only warn when
 * the wallet actually reports a different network.
 */
export function isNetworkMismatch(walletNetwork: string | null | undefined): boolean {
  if (!walletNetwork) return false;
  return walletNetwork.trim().toUpperCase() !== getExpectedNetwork();
}

/** Banner copy naming both sides of a network mismatch. */
export function describeNetworkMismatch(walletNetwork: string | null | undefined): string {
  const expected = getExpectedNetwork();
  if (!walletNetwork) {
    return `Switch Freighter to ${expected} to continue.`;
  }
  return `Freighter is connected to ${walletNetwork.toUpperCase()} but this app runs on ${expected}. Switch networks in Freighter and reconnect.`;
}
