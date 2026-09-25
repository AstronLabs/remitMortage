// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Client-side verification-registry lookup backed by Stellar Horizon.
//
// A verified account carries a data entry (`remit_verified_until`) whose value
// is the Unix-seconds timestamp at which its verification expires. This module
// reads that entry straight from Horizon and derives a badge state, with two
// guards that keep the dashboard responsive:
//
//   1. A short-lived result cache (per address) so repeated renders don't
//      re-hit Horizon, and
//   2. An in-flight request map so concurrent lookups for the same address
//      share a single Horizon request instead of firing duplicates.
//
// Expiry is always re-evaluated against the current time — even on a cache hit —
// so a record that lapses inside the cache window correctly flips to unverified.

import { Horizon } from "@stellar/stellar-sdk";

/** Account data-entry key that stores the verification expiry (Unix seconds). */
export const VERIFICATION_DATA_KEY = "remit_verified_until";

/** How long a resolved lookup is cached before Horizon is queried again. */
export const VERIFICATION_CACHE_TTL_MS = 60_000;

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL || "https://horizon-testnet.stellar.org";

export type VerificationState = "verified" | "unverified";

export interface VerificationRecord {
  address: string;
  state: VerificationState;
  /** Expiry in Unix seconds, or null when the account holds no record. */
  verifiedUntil: number | null;
  /** When this record was resolved (Unix ms). */
  checkedAt: number;
}

/**
 * Fetches an account's data entries as a map of key → base64 value, mirroring
 * Horizon's `data_attr`. Injectable so tests need no live network.
 */
export type AccountDataFetcher = (
  address: string
) => Promise<Record<string, string>>;

interface GetVerificationOptions {
  fetcher?: AccountDataFetcher;
  now?: () => number;
  /** Bypass the cache and force a fresh Horizon lookup. */
  force?: boolean;
}

interface CacheEntry {
  record: VerificationRecord;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<VerificationRecord>>();

/** Decode a base64 data-entry value to its UTF-8 string form. */
function decodeBase64(value: string): string {
  if (typeof atob === "function") {
    return atob(value);
  }
  // Node fallback (tests / SSR) when atob is unavailable.
  return Buffer.from(value, "base64").toString("utf-8");
}

/**
 * Default fetcher: reads the connected account's data entries from Horizon.
 * A missing account (404) is treated as "no verification record" rather than an
 * error, so an unfunded/unknown wallet simply shows as unverified.
 */
async function defaultFetcher(address: string): Promise<Record<string, string>> {
  const server = new Horizon.Server(HORIZON_URL, {
    allowHttp: HORIZON_URL.startsWith("http://"),
  });
  try {
    const account = await server.accounts().accountId(address).call();
    return (account.data_attr as Record<string, string>) ?? {};
  } catch (err: unknown) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 404) return {};
    throw err;
  }
}

/** Parse the verification expiry (Unix seconds) from a data-entry map. */
function parseVerifiedUntil(data: Record<string, string>): number | null {
  const raw = data[VERIFICATION_DATA_KEY];
  if (!raw) return null;
  const decoded = decodeBase64(raw).trim();
  const seconds = Number(decoded);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Derive the badge state from an expiry timestamp and the current time. */
function deriveState(
  verifiedUntil: number | null,
  nowMs: number
): VerificationState {
  if (verifiedUntil === null) return "unverified";
  // Expired records (verifiedUntil in the past) are treated as unverified.
  return verifiedUntil * 1000 > nowMs ? "verified" : "unverified";
}

/**
 * Resolve the verification state for an address.
 *
 * Uses the cache when a fresh entry exists (re-evaluating expiry against the
 * current time), coalesces concurrent lookups for the same address into one
 * Horizon request, and caches the result for {@link VERIFICATION_CACHE_TTL_MS}.
 */
export async function getVerificationStatus(
  address: string,
  options: GetVerificationOptions = {}
): Promise<VerificationRecord> {
  const now = options.now ?? Date.now;
  const fetcher = options.fetcher ?? defaultFetcher;
  const nowMs = now();

  if (!options.force) {
    const cached = cache.get(address);
    if (cached && cached.expiresAt > nowMs) {
      // Re-derive state so a record that expired within the TTL flips correctly.
      const state = deriveState(cached.record.verifiedUntil, nowMs);
      if (state === cached.record.state) return cached.record;
      const updated: VerificationRecord = { ...cached.record, state };
      cache.set(address, { record: updated, expiresAt: cached.expiresAt });
      return updated;
    }

    // Share an already-running lookup instead of issuing a duplicate request.
    const pending = inFlight.get(address);
    if (pending) return pending;
  }

  const lookup = (async () => {
    try {
      const data = await fetcher(address);
      const verifiedUntil = parseVerifiedUntil(data);
      const record: VerificationRecord = {
        address,
        state: deriveState(verifiedUntil, now()),
        verifiedUntil,
        checkedAt: now(),
      };
      cache.set(address, {
        record,
        expiresAt: now() + VERIFICATION_CACHE_TTL_MS,
      });
      return record;
    } finally {
      inFlight.delete(address);
    }
  })();

  inFlight.set(address, lookup);
  return lookup;
}

/** Clear cached and in-flight lookups (primarily for tests). */
export function clearVerificationCache(): void {
  cache.clear();
  inFlight.clear();
}
