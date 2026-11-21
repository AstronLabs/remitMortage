// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Development-only fault injection hooks.
 *
 * Resilience code — retries, failover and circuit breakers — can otherwise only
 * be exercised by actually breaking a dependency, which is slow and awkward to
 * reproduce locally. These hooks let a developer (or a test) force a chosen
 * dependency call to fail, time out, or surface a specific error, so the
 * resilience paths can be driven directly instead of mocking at the network
 * layer.
 *
 * The mechanism is inert in production: the environment guard is re-checked on
 * every read and every injection, so neither arming a fault nor triggering one
 * can have any effect when NODE_ENV === "production".
 */

export type FaultMode = "error" | "timeout";

export interface FaultRule {
  /** `error` (default) rejects immediately; `timeout` hangs then rejects. */
  mode?: FaultMode;
  /** Custom error message, for returning a specific error. */
  message?: string;
  /** Custom error code, surfaced as `error.code`. */
  code?: string;
  /** HTTP status to synthesise on `error.response.status` (e.g. 429, 503). */
  status?: number;
  /** Delay before rejecting, chiefly to simulate a timeout (ms). */
  delayMs?: number;
  /** Inject at most this many times, then clear the rule. Omit for unlimited. */
  times?: number;
}

/** Error thrown when a fault is injected, so callers can detect it. */
export class FaultInjectionError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly isFaultInjection = true;
  readonly response?: { status: number; data?: unknown };

  constructor(key: string, rule: FaultRule) {
    const timedOut = rule.mode === "timeout";
    super(rule.message ?? `Injected ${timedOut ? "timeout" : "fault"} for "${key}"`);
    this.name = "FaultInjectionError";
    this.code = rule.code;
    this.status = rule.status;
    if (rule.status !== undefined) {
      this.response = { status: rule.status, data: { error: { details: this.message } } };
    }
  }
}

/** Well-known keys for the dependency calls that can be faulted. */
export const FAULT_INJECTION_KEYS = {
  /** Soroban RPC calls made through the failover manager. */
  rpc: "soroban.rpc",
  /** Primary KYC/OCR provider. */
  kycPrimary: "kyc.primary",
  /** Backup KYC/OCR provider. */
  kycBackup: "kyc.backup",
} as const;

const rules = new Map<string, FaultRule>();

/** True everywhere except a production build. */
export function isFaultInjectionEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/**
 * Arm a fault for a dependency call. A no-op in production, so a fault can
 * never be registered there.
 */
export function registerFault(key: string, rule: FaultRule = {}): void {
  if (!isFaultInjectionEnabled()) return;
  rules.set(key, rule);
}

/** Remove a single armed fault. */
export function clearFault(key: string): void {
  rules.delete(key);
}

/** Remove every armed fault. Intended for test teardown. */
export function clearAllFaults(): void {
  rules.clear();
}

/** Number of currently armed faults; always 0 in production. */
export function faultCount(): number {
  return isFaultInjectionEnabled() ? rules.size : 0;
}

/**
 * If a fault is armed for `key`, simulate it by throwing. Resolves otherwise.
 * Always a no-op in production, so the production code path is unchanged.
 */
export async function maybeInjectFault(key: string): Promise<void> {
  if (!isFaultInjectionEnabled()) return;

  const rule = rules.get(key);
  if (!rule) return;

  if (rule.times !== undefined) {
    const remaining = rule.times - 1;
    if (remaining <= 0) rules.delete(key);
    else rules.set(key, { ...rule, times: remaining });
  }

  if (rule.delayMs && rule.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, rule.delayMs));
  }

  throw new FaultInjectionError(key, rule);
}

/**
 * Run `fn`, first applying any fault armed for `key`. In production this is a
 * transparent pass-through.
 */
export async function withFaultInjection<T>(key: string, fn: () => Promise<T>): Promise<T> {
  await maybeInjectFault(key);
  return fn();
}
