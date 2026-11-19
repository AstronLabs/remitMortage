// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Device binding for admin sessions (issue #886).
 *
 * A stolen admin session cookie is the most damaging kind of session theft:
 * it carries full privilege, it looks exactly like the real admin to every
 * log, and rotating it requires noticing it first. Binding fixes the economics
 * — the cookie alone stops being enough.
 *
 * ## How it works
 *
 * 1. The admin's browser generates a **non-extractable** Ed25519 keypair and
 *    enrols the public key (`POST /api/admin/devices/enroll`). The private key
 *    never leaves the device and cannot be read by script, so it cannot be
 *    exfiltrated the way a cookie can.
 * 2. Enrolment re-issues the session cookie with a `dbk` claim: the SHA-256
 *    fingerprint of that public key. The session is now *bound* — the token
 *    itself names the only device allowed to use it.
 * 3. Every subsequent admin request carries a fresh signature over
 *    `v1|deviceId|timestamp|nonce|METHOD|path|bodyHash`
 *    ({@link canonicalProofString}). {@link verifyDeviceProof} checks the
 *    signature against the enrolled public key, that the fingerprint matches
 *    the session's `dbk`, that the timestamp is inside the skew window, and
 *    that the nonce has not been seen before.
 *
 * A copied cookie replayed from another machine fails at step 3: the attacker
 * has the token and its `dbk` claim, but not the key that `dbk` commits to, so
 * no valid signature can be produced.
 *
 * ## Why in-memory
 *
 * The store here follows `services/totpAuth.ts` and `services/lockoutService.ts`:
 * single-process, no migration. The consequence is explicit — a restart drops
 * enrolments and every admin re-enrols on next login, which fails *closed*.
 * Moving it to Postgres is a drop-in change behind this module's API.
 */

import crypto from "crypto";
import nacl from "tweetnacl";
import logger from "../utils/logger.js";

/** Proof-string version, so the format can change without silent acceptance. */
export const PROOF_VERSION = "v1";

/** Headers a bound client sends on every admin request. */
export const DEVICE_ID_HEADER = "x-device-id";
export const DEVICE_TIMESTAMP_HEADER = "x-device-timestamp";
export const DEVICE_NONCE_HEADER = "x-device-nonce";
export const DEVICE_SIGNATURE_HEADER = "x-device-signature";

/** How far a proof's timestamp may be from server time, in either direction. */
export const PROOF_SKEW_MS = 60_000;

/** Minimum nonce length; short nonces are too easy to collide by accident. */
const MIN_NONCE_LENGTH = 16;

/** Ed25519 public keys are exactly 32 bytes. */
const ED25519_PUBLIC_KEY_BYTES = 32;

export interface AdminDevice {
  deviceId: string;
  /** Lowercased admin wallet address this device belongs to. */
  adminAddress: string;
  /** Base64 Ed25519 public key (32 bytes). */
  publicKey: string;
  /** SHA-256 of the raw public key bytes, hex. This is the session's `dbk`. */
  fingerprint: string;
  /** Human label shown in the device list ("MacBook Pro — Chrome"). */
  label: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
}

/** Everything a caller needs to show the admin their devices. */
export type AdminDeviceSummary = Omit<AdminDevice, "publicKey">;

export type BindingFailureReason =
  | "binding_not_configured"
  | "missing_proof"
  | "malformed_proof"
  | "unknown_device"
  | "device_revoked"
  | "device_owner_mismatch"
  | "device_mismatch"
  | "stale_proof"
  | "replayed_proof"
  | "invalid_signature";

export type DeviceProofResult =
  | { ok: true; device: AdminDevice }
  | { ok: false; reason: BindingFailureReason; detail?: string };

/**
 * Enforcement level, from `ADMIN_DEVICE_BINDING`:
 *
 * - `enforce` — an unbound session or a failed proof is rejected. The default
 *   in production.
 * - `monitor` — failures are logged and audited but the request proceeds, so
 *   the feature can be rolled out before every admin client is updated. The
 *   default everywhere else.
 * - `off`     — the middleware is a pass-through.
 */
export type BindingMode = "off" | "monitor" | "enforce";

export function deviceBindingMode(): BindingMode {
  const raw = (process.env.ADMIN_DEVICE_BINDING ?? "").toLowerCase().trim();
  if (raw === "off" || raw === "monitor" || raw === "enforce") return raw;
  return process.env.NODE_ENV === "production" ? "enforce" : "monitor";
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const devices = new Map<string, AdminDevice>();

/** Seen nonces -> expiry, so a captured proof cannot be replayed verbatim. */
const seenNonces = new Map<string, number>();

function pruneNonces(now: number): void {
  for (const [nonce, expiresAt] of seenNonces) {
    if (expiresAt <= now) seenNonces.delete(nonce);
  }
}

/** Test hook: clears enrolled devices and the replay cache. */
export function _resetAdminDeviceStore(): void {
  devices.clear();
  seenNonces.clear();
}

// ---------------------------------------------------------------------------
// Keys and fingerprints
// ---------------------------------------------------------------------------

function decodePublicKey(publicKey: string): Uint8Array | null {
  try {
    const bytes = Buffer.from(publicKey, "base64");
    // Buffer.from is lenient: it silently drops invalid characters, so the
    // length check is what actually validates the input.
    if (bytes.length !== ED25519_PUBLIC_KEY_BYTES) return null;
    return new Uint8Array(bytes);
  } catch {
    return null;
  }
}

/**
 * SHA-256 of the raw public key bytes, hex. Stamped into the session token as
 * `dbk`, so the token commits to one device without carrying the key itself.
 */
export function fingerprintPublicKey(publicKey: string): string | null {
  const bytes = decodePublicKey(publicKey);
  if (!bytes) return null;
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** SHA-256 of a request body, hex. `""` for a body-less request. */
export function hashRequestBody(raw: string | Buffer | undefined | null): string {
  if (raw === undefined || raw === null || raw.length === 0) {
    return crypto.createHash("sha256").update("").digest("hex");
  }
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/**
 * The exact string a device signs. Both the server and the browser helper
 * (`frontend/src/lib/admin-device-key.ts`) build it from this definition — if
 * they ever disagree, every proof fails closed.
 *
 * `method` is upper-cased and `path` excludes the query string, so a proof is
 * bound to the operation without being invalidated by cache-busting params.
 */
export function canonicalProofString(input: {
  deviceId: string;
  timestamp: number;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return [
    PROOF_VERSION,
    input.deviceId,
    String(input.timestamp),
    input.nonce,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
  ].join("|");
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export class DeviceEnrolmentError extends Error {
  readonly code: "invalid_public_key" | "invalid_label";

  constructor(code: "invalid_public_key" | "invalid_label", message: string) {
    super(message);
    this.name = "DeviceEnrolmentError";
    this.code = code;
  }
}

/**
 * Registers a device's public key against an admin and returns the stored
 * record. The caller is responsible for re-issuing the session cookie with
 * `fingerprint` as the `dbk` claim — until it does, the session is unbound.
 *
 * Re-enrolling the same public key for the same admin is idempotent: it
 * returns the existing (un-revoked) record rather than piling up duplicates,
 * so a page reload during enrolment does not create a second device.
 */
export function enrollAdminDevice(input: {
  adminAddress: string;
  publicKey: string;
  label?: string;
}): AdminDevice {
  const fingerprint = fingerprintPublicKey(input.publicKey);
  if (!fingerprint) {
    throw new DeviceEnrolmentError(
      "invalid_public_key",
      "publicKey must be a base64-encoded 32-byte Ed25519 public key"
    );
  }

  const label = (input.label ?? "").trim() || "Unnamed device";
  if (label.length > 120) {
    throw new DeviceEnrolmentError("invalid_label", "label must be 120 characters or fewer");
  }

  const adminAddress = input.adminAddress.toLowerCase();

  for (const device of devices.values()) {
    if (
      device.adminAddress === adminAddress &&
      device.fingerprint === fingerprint &&
      device.revokedAt === null
    ) {
      device.label = label;
      return device;
    }
  }

  const device: AdminDevice = {
    deviceId: crypto.randomUUID(),
    adminAddress,
    publicKey: input.publicKey,
    fingerprint,
    label,
    createdAt: new Date(),
    lastSeenAt: null,
    revokedAt: null,
    revokedReason: null,
  };

  devices.set(device.deviceId, device);
  logger.info("[device-binding] device enrolled", {
    adminAddress,
    deviceId: device.deviceId,
    label,
  });

  return device;
}

export function getAdminDevice(deviceId: string): AdminDevice | null {
  return devices.get(deviceId) ?? null;
}

/** Devices for one admin, newest first, without the public keys. */
export function listAdminDevices(adminAddress: string): AdminDeviceSummary[] {
  const owner = adminAddress.toLowerCase();
  return [...devices.values()]
    .filter((device) => device.adminAddress === owner)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .map(({ publicKey: _publicKey, ...summary }) => summary);
}

/**
 * Revokes a device. Any session bound to it fails its next proof and must
 * re-authenticate. Returns null when the device does not exist or does not
 * belong to `adminAddress` — callers answer 404 either way, so one admin
 * cannot probe another's device ids.
 */
export function revokeAdminDevice(
  deviceId: string,
  adminAddress: string,
  reason = "revoked_by_admin"
): AdminDeviceSummary | null {
  const device = devices.get(deviceId);
  if (!device || device.adminAddress !== adminAddress.toLowerCase()) return null;

  if (device.revokedAt === null) {
    device.revokedAt = new Date();
    device.revokedReason = reason;
    logger.warn("[device-binding] device revoked", { deviceId, adminAddress, reason });
  }

  const { publicKey: _publicKey, ...summary } = device;
  return summary;
}

// ---------------------------------------------------------------------------
// Proof verification
// ---------------------------------------------------------------------------

export interface DeviceProofInput {
  /** Admin identity from the verified session token. */
  adminAddress: string;
  /** The session token's `dbk` claim, or undefined for an unbound session. */
  sessionFingerprint: string | undefined;
  deviceId: unknown;
  timestamp: unknown;
  nonce: unknown;
  signature: unknown;
  method: string;
  /** Request path without the query string. */
  path: string;
  bodyHash: string;
  /** Injectable clock for tests. */
  now?: number;
}

/**
 * Verifies one request's device proof.
 *
 * Returns a reason rather than throwing, because every reason maps to a
 * different operator-visible outcome: `device_mismatch` is a replay from
 * another machine and pages someone, `stale_proof` is usually clock drift.
 */
export function verifyDeviceProof(input: DeviceProofInput): DeviceProofResult {
  const now = input.now ?? Date.now();

  if (
    typeof input.deviceId !== "string" ||
    typeof input.signature !== "string" ||
    typeof input.nonce !== "string" ||
    (typeof input.timestamp !== "string" && typeof input.timestamp !== "number")
  ) {
    return { ok: false, reason: "missing_proof" };
  }

  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || input.nonce.length < MIN_NONCE_LENGTH) {
    return { ok: false, reason: "malformed_proof" };
  }

  const device = devices.get(input.deviceId);
  if (!device) return { ok: false, reason: "unknown_device" };
  if (device.revokedAt !== null) return { ok: false, reason: "device_revoked" };
  if (device.adminAddress !== input.adminAddress.toLowerCase()) {
    // The device exists but belongs to a different admin: reported separately
    // because it means a device was enrolled under the wrong identity, not
    // that a cookie was copied.
    return { ok: false, reason: "device_owner_mismatch" };
  }

  // The binding check proper: the session token named a device, and this is
  // not it. A copied cookie presented with the thief's own enrolled device
  // lands here.
  if (device.fingerprint !== input.sessionFingerprint) {
    return { ok: false, reason: "device_mismatch" };
  }

  if (Math.abs(now - timestamp) > PROOF_SKEW_MS) {
    return { ok: false, reason: "stale_proof" };
  }

  pruneNonces(now);
  // The nonce is namespaced by device so two devices cannot lock each other out.
  const nonceKey = `${device.deviceId}:${input.nonce}`;
  if (seenNonces.has(nonceKey)) {
    return { ok: false, reason: "replayed_proof" };
  }

  const publicKey = decodePublicKey(device.publicKey);
  if (!publicKey) {
    // Only reachable if a stored record was corrupted; treated as a hard fail.
    return { ok: false, reason: "invalid_signature", detail: "stored public key is unusable" };
  }

  let signatureBytes: Uint8Array;
  try {
    const buffer = Buffer.from(input.signature, "base64");
    if (buffer.length !== nacl.sign.signatureLength) {
      return { ok: false, reason: "malformed_proof", detail: "signature length" };
    }
    signatureBytes = new Uint8Array(buffer);
  } catch {
    return { ok: false, reason: "malformed_proof", detail: "signature encoding" };
  }

  const message = new TextEncoder().encode(
    canonicalProofString({
      deviceId: device.deviceId,
      timestamp,
      nonce: input.nonce,
      method: input.method,
      path: input.path,
      bodyHash: input.bodyHash,
    })
  );

  if (!nacl.sign.detached.verify(message, signatureBytes, publicKey)) {
    return { ok: false, reason: "invalid_signature" };
  }

  // Only record the nonce once the signature is known good, so an attacker
  // cannot burn a legitimate client's nonces with forged proofs.
  seenNonces.set(nonceKey, now + PROOF_SKEW_MS * 2);
  device.lastSeenAt = new Date(now);

  return { ok: true, device };
}

/** Operator-facing explanation for each failure reason. */
export const BINDING_FAILURE_MESSAGES: Record<BindingFailureReason, string> = {
  binding_not_configured:
    "This admin session is not bound to a device. Enrol this device to continue.",
  missing_proof: "This admin session requires a device signature on every request.",
  malformed_proof: "The device signature was malformed.",
  unknown_device: "This device is not enrolled for admin access.",
  device_revoked: "This device has been revoked. Enrol it again to continue.",
  device_owner_mismatch: "This device is enrolled to a different admin account.",
  device_mismatch: "This session is bound to a different device.",
  stale_proof: "The device signature has expired. Check the device clock and retry.",
  replayed_proof: "This device signature has already been used.",
  invalid_signature: "The device signature could not be verified.",
};
