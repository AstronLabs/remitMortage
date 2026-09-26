// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { SimulationEstimate } from "./soroban-client";

/**
 * Session-scoped cache of Soroban simulation results.
 *
 * Simulating a contract call costs an RPC roundtrip, and the resource
 * footprint for the same call shape barely moves between submissions. Caching
 * it in `sessionStorage` lets a modal show recommended fees immediately on
 * reopen, while a fresh simulation still runs in the background before signing.
 */

export const SIMULATION_CACHE_PREFIX = "rm_sim_footprint:";

/** Entries older than this are ignored and evicted. */
export const SIMULATION_CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = {
  estimate: SimulationEstimate;
  cachedAt: number;
};

export type SimulationCacheKeyParts = {
  /** Contract the call targets. */
  contractId: string;
  /** Contract method name, e.g. "deposit". */
  method: string;
  /** Source account, since the footprint depends on it. */
  account: string;
  /**
   * Extra values that change the footprint (amounts, goal ids, …). Values are
   * stringified, so pass primitives.
   */
  args?: Array<string | number | bigint>;
};

export function buildSimulationCacheKey({
  contractId,
  method,
  account,
  args = [],
}: SimulationCacheKeyParts): string {
  const suffix = args.map((arg) => String(arg)).join("|");
  return `${SIMULATION_CACHE_PREFIX}${contractId}:${method}:${account}:${suffix}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    // Storage can throw in private-browsing or sandboxed contexts.
    return null;
  }
}

/** Returns the cached estimate for `key`, or null when absent or stale. */
export function readCachedSimulation(
  key: string,
  now: number = Date.now()
): SimulationEstimate | null {
  const storage = getStorage();
  if (!storage) return null;

  const raw = storage.getItem(key);
  if (!raw) return null;

  try {
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry?.estimate || typeof entry.cachedAt !== "number") {
      storage.removeItem(key);
      return null;
    }
    if (now - entry.cachedAt > SIMULATION_CACHE_TTL_MS) {
      storage.removeItem(key);
      return null;
    }
    return entry.estimate;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

export function writeCachedSimulation(
  key: string,
  estimate: SimulationEstimate,
  now: number = Date.now()
): void {
  const storage = getStorage();
  if (!storage) return;

  const entry: CacheEntry = { estimate, cachedAt: now };
  try {
    storage.setItem(key, JSON.stringify(entry));
  } catch {
    // Quota errors are non-fatal: the caller just re-simulates next time.
  }
}

/** Drops every cached simulation. Call after a network or account switch. */
export function clearSimulationCache(): void {
  const storage = getStorage();
  if (!storage) return;

  const staleKeys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && key.startsWith(SIMULATION_CACHE_PREFIX)) staleKeys.push(key);
  }
  staleKeys.forEach((key) => storage.removeItem(key));
}
