// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Credential-stuffing detection and adaptive lockout (issue #737).
 *
 * Per-account rate limiting alone cannot catch the stuffing signature: many
 * distinct accounts, each with a different plausible password, failing in a
 * short window from a correlated source (IP / /24 range / ASN / device
 * fingerprint). This module correlates failures by source, not by account.
 *
 * When a source crosses the severity threshold it is placed under adaptive
 * lockout: step-up verification (CAPTCHA marker) + progressive delay, scoped
 * ONLY to that source so unrelated users are unaffected. Crossing the alert
 * threshold also emits a security/on-call alert (log + injectable hook).
 */

import logger from "../utils/logger.js";

export interface CredentialFailureEvent {
  /** Account identifier attempted (email / wallet / username), lower-cased internally. */
  account: string;
  /** Remote IP (v4/v6). */
  ip?: string;
  /** Autonomous system number / provider label, when known (e.g. from headers). */
  asn?: string;
  /** Client fingerprint (device / TLS / header hash), when supplied. */
  fingerprint?: string;
  /** Event time; defaults to now. Injectable for tests. */
  atMs?: number;
}

export interface StuffingDetectorOptions {
  /** Sliding window for correlation (ms). Default 5 min. */
  windowMs?: number;
  /** Distinct accounts in window that flags a source. Default 10. */
  distinctAccountsThreshold?: number;
  /** Total failures in window that flags a source. Default 20. */
  totalFailuresThreshold?: number;
  /** Adaptive lockout duration once flagged (ms). Default 15 min. */
  lockoutMs?: number;
  /** Step-up delay applied per request while locked (ms). Default 2000. */
  stepUpDelayMs?: number;
  /** Injectable alert sink (security/on-call). Defaults to logger. */
  onAlert?: (episode: StuffingEpisode) => void;
  now?: () => number;
}

export interface StuffingEpisode {
  source: string;
  kind: "ip" | "subnet" | "asn" | "fingerprint";
  distinctAccounts: number;
  totalFailures: number;
  windowMs: number;
  firstSeenMs: number;
  lastSeenMs: number;
  lockedUntilMs: number;
}

interface SourceBucket {
  failures: Array<{ account: string; atMs: number }>;
  lockedUntilMs: number;
  alertedAtMs: number;
  lastEpisode?: StuffingEpisode;
}

const buckets = new Map<string, SourceBucket>();

export function _clearCredentialStuffingState(): void {
  buckets.clear();
}

function defaultOptions(): Required<Omit<StuffingDetectorOptions, "onAlert">> & Pick<StuffingDetectorOptions, "onAlert"> {
  return {
    windowMs: Number(process.env.CREDENTIAL_STUFFING_WINDOW_MS ?? 5 * 60 * 1000),
    distinctAccountsThreshold: Number(process.env.CREDENTIAL_STUFFING_ACCOUNTS ?? 10),
    totalFailuresThreshold: Number(process.env.CREDENTIAL_STUFFING_FAILURES ?? 20),
    lockoutMs: Number(process.env.CREDENTIAL_STUFFING_LOCKOUT_MS ?? 15 * 60 * 1000),
    stepUpDelayMs: Number(process.env.CREDENTIAL_STUFFING_STEPUP_DELAY_MS ?? 2000),
    now: () => Date.now(),
  };
}

/** /24 for v4; /64-ish prefix for v6 (first 4 hextets) — coarse correlation only. */
export function toSubnet(ip: string): string | null {
  const trimmed = ip.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) {
    return trimmed.split(".").slice(0, 3).join(".") + ".0/24";
  }
  if (trimmed.includes(":")) {
    const parts = trimmed.split(":").filter((p) => p.length > 0);
    return parts.slice(0, 4).join(":") + "::/64";
  }
  return null;
}

/** All correlated source keys for one failure event. */
export function deriveSourceKeys(event: CredentialFailureEvent): Array<{ source: string; kind: StuffingEpisode["kind"] }> {
  const keys: Array<{ source: string; kind: StuffingEpisode["kind"] }> = [];
  if (event.ip) {
    keys.push({ source: `ip:${event.ip.trim().toLowerCase()}`, kind: "ip" });
    const subnet = toSubnet(event.ip);
    if (subnet) keys.push({ source: `subnet:${subnet}`, kind: "subnet" });
  }
  if (event.asn) keys.push({ source: `asn:${event.asn.trim().toLowerCase()}`, kind: "asn" });
  if (event.fingerprint) keys.push({ source: `fp:${event.fingerprint.trim().toLowerCase()}`, kind: "fingerprint" });
  if (keys.length === 0) keys.push({ source: "ip:unknown", kind: "ip" });
  return keys;
}

function prune(bucket: SourceBucket, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  bucket.failures = bucket.failures.filter((f) => f.atMs >= cutoff);
}

function defaultAlert(episode: StuffingEpisode): void {
  logger.error("[security] credential-stuffing episode detected", {
    source: episode.source,
    kind: episode.kind,
    distinctAccounts: episode.distinctAccounts,
    totalFailures: episode.totalFailures,
    lockedUntil: new Date(episode.lockedUntilMs).toISOString(),
  });
}

/**
 * Record one failed login and evaluate the stuffing signature for every
 * correlated source. Returns the episodes newly locked by this event.
 */
export function recordCredentialFailure(
  event: CredentialFailureEvent,
  opts: StuffingDetectorOptions = {}
): { detected: boolean; episodes: StuffingEpisode[] } {
  const cfg = { ...defaultOptions(), ...opts };
  const now = event.atMs ?? cfg.now();
  const account = String(event.account ?? "").trim().toLowerCase() || "unknown";
  const onAlert = opts.onAlert ?? defaultAlert;

  const episodes: StuffingEpisode[] = [];
  for (const { source, kind } of deriveSourceKeys(event)) {
    let bucket = buckets.get(source);
    if (!bucket) {
      bucket = { failures: [], lockedUntilMs: 0, alertedAtMs: 0 };
      buckets.set(source, bucket);
    }
    prune(bucket, now, cfg.windowMs);
    bucket.failures.push({ account, atMs: now });

    const distinctAccounts = new Set(bucket.failures.map((f) => f.account)).size;
    const totalFailures = bucket.failures.length;
    const signature =
      distinctAccounts >= cfg.distinctAccountsThreshold &&
      totalFailures >= cfg.totalFailuresThreshold;

    if (signature && bucket.lockedUntilMs <= now) {
      bucket.lockedUntilMs = now + cfg.lockoutMs;
      const episode: StuffingEpisode = {
        source,
        kind,
        distinctAccounts,
        totalFailures,
        windowMs: cfg.windowMs,
        firstSeenMs: bucket.failures[0]?.atMs ?? now,
        lastSeenMs: now,
        lockedUntilMs: bucket.lockedUntilMs,
      };
      bucket.lastEpisode = episode;
      // Alert once per lockout episode (not on every subsequent failure).
      if (bucket.alertedAtMs < now - cfg.windowMs) {
        bucket.alertedAtMs = now;
        try {
          onAlert(episode);
        } catch (err) {
          logger.warn("[security] stuffing alert sink threw", { err });
        }
      }
      episodes.push(episode);
    }
  }

  return { detected: episodes.length > 0, episodes };
}

/** True when any correlated source for this context is under adaptive lockout. */
export function isStuffingSourceLocked(
  event: Pick<CredentialFailureEvent, "ip" | "asn" | "fingerprint">,
  nowMs = Date.now()
): { locked: boolean; sources: string[]; lockedUntilMs?: number; requireCaptcha?: boolean; delayMs?: number } {
  const keys = deriveSourceKeys({ account: "probe", ...event });
  const lockedSources: string[] = [];
  let lockedUntilMs = 0;
  for (const { source } of keys) {
    const bucket = buckets.get(source);
    if (bucket && bucket.lockedUntilMs > nowMs) {
      lockedSources.push(source);
      lockedUntilMs = Math.max(lockedUntilMs, bucket.lockedUntilMs);
    }
  }
  if (lockedSources.length === 0) return { locked: false, sources: [] };
  return {
    locked: true,
    sources: lockedSources,
    lockedUntilMs,
    requireCaptcha: true,
    delayMs: Number(process.env.CREDENTIAL_STUFFING_STEPUP_DELAY_MS ?? 2000),
  };
}

/** Step-up / adaptive action for a locked source (CAPTCHA + delay, source-scoped). */
export function getAdaptiveAction(source: string, nowMs = Date.now()): {
  locked: boolean;
  requireCaptcha: boolean;
  delayMs: number;
  remainingMs?: number;
} {
  const bucket = buckets.get(source);
  if (!bucket || bucket.lockedUntilMs <= nowMs) {
    return { locked: false, requireCaptcha: false, delayMs: 0 };
  }
  return {
    locked: true,
    requireCaptcha: true,
    delayMs: Number(process.env.CREDENTIAL_STUFFING_STEPUP_DELAY_MS ?? 2000),
    remainingMs: bucket.lockedUntilMs - nowMs,
  };
}
