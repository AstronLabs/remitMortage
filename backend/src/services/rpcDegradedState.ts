// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Process-wide Soroban RPC degraded flag (issue #984).
 *
 * The background {@link RpcHealthMonitor} updates this state after every probe
 * sweep. Reads keep serving from the database/cache while the RPC is down and
 * are marked as possibly stale; chain-dependent writes use the same flag to
 * fail fast with a retryable error.
 */

let degraded = false;
let lastCheckedAt: string | null = null;

export interface RpcDegradedState {
  degraded: boolean;
  lastCheckedAt: string | null;
}

/** Set by the health monitor after each probe sweep. */
export function setRpcDegradedState(value: boolean, checkedAt: string = new Date().toISOString()): void {
  degraded = value;
  lastCheckedAt = checkedAt;
}

/** True while no configured Soroban RPC node is healthy. */
export function isRpcDegraded(): boolean {
  return degraded;
}

/** Snapshot for internal health/status reporting. */
export function getRpcDegradedState(): RpcDegradedState {
  return { degraded, lastCheckedAt };
}

/** Test hook: return to the pre-first-probe (normal) state. */
export function resetRpcDegradedState(): void {
  degraded = false;
  lastCheckedAt = null;
}
