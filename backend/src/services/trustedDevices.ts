// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Trusted devices for step-up verification (issue #1105).
 *
 * After completing step-up verification a user may mark the current device
 * as trusted. The device receives an opaque random token (as an httpOnly
 * cookie); only its SHA-256 hash is stored. A later login that presents a
 * still-valid token for the same wallet skips the location step-up until
 * the admin-configurable trust period elapses or the user revokes the
 * device. Revocation is checked on every lookup, so it takes effect on the
 * device's very next login attempt.
 *
 * Kept in-memory alongside `userSessions.ts`, which the session management
 * page already lists from.
 */

import crypto from "crypto";
import { summarizeDevice } from "./userSessions.js";

export const TRUSTED_DEVICE_COOKIE = "trusted_device";

const DEFAULT_TRUST_PERIOD_DAYS = 30;
/** Upper bound an admin may configure, so a trust grant can't become effectively permanent. */
export const MAX_TRUST_PERIOD_DAYS = 365;

export interface TrustedDevice {
  deviceId: string;
  walletAddress: string;
  deviceSummary: string;
  trustedAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt?: string;
}

interface StoredTrustedDevice extends TrustedDevice {
  tokenHash: string;
}

const devices = new Map<string, StoredTrustedDevice>();
let trustPeriodDaysOverride: number | null = null;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function publicView(d: StoredTrustedDevice): TrustedDevice {
  const { tokenHash: _tokenHash, ...rest } = d;
  return { ...rest };
}

function envTrustPeriodDays(): number {
  const parsed = parseInt(process.env.TRUSTED_DEVICE_TTL_DAYS || "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TRUST_PERIOD_DAYS
    ? parsed
    : DEFAULT_TRUST_PERIOD_DAYS;
}

/** Current trust period: the admin override if set, else `TRUSTED_DEVICE_TTL_DAYS`, else 30 days. */
export function getTrustPeriodDays(): number {
  return trustPeriodDaysOverride ?? envTrustPeriodDays();
}

/** Admin override for the trust period. Applies to devices trusted from now on. */
export function setTrustPeriodDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > MAX_TRUST_PERIOD_DAYS) {
    throw new RangeError(`Trust period must be an integer between 1 and ${MAX_TRUST_PERIOD_DAYS} days`);
  }
  trustPeriodDaysOverride = days;
}

/**
 * Marks a device as trusted for `walletAddress`. Returns the raw token —
 * the only time it is available — for the caller to hand to the client.
 */
export function trustDevice(
  walletAddress: string,
  userAgent?: string,
  now: Date = new Date()
): { token: string; device: TrustedDevice } {
  const token = crypto.randomBytes(32).toString("hex");
  const device: StoredTrustedDevice = {
    deviceId: crypto.randomUUID(),
    walletAddress: walletAddress.toLowerCase(),
    deviceSummary: summarizeDevice(userAgent),
    trustedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + getTrustPeriodDays() * 24 * 60 * 60 * 1000).toISOString(),
    lastUsedAt: null,
    tokenHash: hashToken(token),
  };
  devices.set(device.deviceId, device);
  return { token, device: publicView(device) };
}

/**
 * True when `token` identifies a device trusted by `walletAddress` that has
 * neither expired nor been revoked. Records the use on success.
 */
export function isTrustedDevice(
  walletAddress: string,
  token: string | undefined,
  now: Date = new Date()
): boolean {
  if (!token || typeof token !== "string") return false;
  const owner = walletAddress.toLowerCase();
  const tokenHash = hashToken(token);
  for (const d of devices.values()) {
    if (d.tokenHash !== tokenHash) continue;
    if (d.walletAddress !== owner || d.revokedAt) return false;
    if (now.getTime() >= new Date(d.expiresAt).getTime()) return false;
    d.lastUsedAt = now.toISOString();
    return true;
  }
  return false;
}

/** Active (unexpired, unrevoked) trusted devices for a wallet, newest first. */
export function listTrustedDevices(walletAddress: string, now: Date = new Date()): TrustedDevice[] {
  const owner = walletAddress.toLowerCase();
  return [...devices.values()]
    .filter((d) => d.walletAddress === owner && !d.revokedAt && new Date(d.expiresAt).getTime() > now.getTime())
    .sort((a, b) => b.trustedAt.localeCompare(a.trustedAt))
    .map(publicView);
}

export type RevokeTrustedDeviceResult =
  | { ok: true; device: TrustedDevice }
  | { ok: false; reason: "not_found" | "forbidden" };

export function revokeTrustedDevice(
  walletAddress: string,
  deviceId: string,
  now: Date = new Date()
): RevokeTrustedDeviceResult {
  const d = devices.get(deviceId);
  if (!d || d.revokedAt) return { ok: false, reason: "not_found" };
  if (d.walletAddress !== walletAddress.toLowerCase()) return { ok: false, reason: "forbidden" };
  d.revokedAt = now.toISOString();
  return { ok: true, device: publicView(d) };
}

/** Clears all trusted devices and the admin override (for test isolation). */
export function clearTrustedDevices(): void {
  devices.clear();
  trustPeriodDaysOverride = null;
}
