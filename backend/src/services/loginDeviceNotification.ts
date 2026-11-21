// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * New-device login notifications (issue #992).
 *
 * A login from a device the account has not used before is worth telling the
 * user about even when its location is unremarkable. The device is recognised
 * by a SHA-256 fingerprint stored with its session; the first sign-in from an
 * unseen fingerprint sends an email (subject to the user's SECURITY/email
 * preference) and always writes an in-app notification, including the time,
 * coarse location and a link to review active sessions.
 */

import crypto from "crypto";
import { createInAppNotification, getNotificationPreference } from "./db.js";
import { getCommunicationPreferences } from "./communicationPreferences.js";
import { createUserSession, isKnownDevice } from "./userSessions.js";
import { getBrandedHtml, sendEmail } from "./email.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";

/** Clients may send an opaque stable device id in this header. */
export const DEVICE_FINGERPRINT_HEADER = "x-device-fingerprint";

export const REVIEW_SESSIONS_PATH = "/settings?tab=security";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Hash the raw device identifier before it is stored. Lower-cased so a
 * case-only change in a client-supplied id does not look like a new device.
 */
export function hashDeviceFingerprint(raw: string): string {
  return crypto.createHash("sha256").update(raw.trim().toLowerCase()).digest("hex");
}

/**
 * Derive the fingerprint for a request: a client-supplied device id when
 * present, otherwise the user agent. The raw value never leaves this module.
 */
export function deviceFingerprintFromHeaders(headers: Record<string, unknown>): string {
  const supplied = headers[DEVICE_FINGERPRINT_HEADER];
  const raw = Array.isArray(supplied) ? supplied[0] : supplied;
  const source =
    typeof raw === "string" && raw.trim() !== ""
      ? raw
      : typeof headers["user-agent"] === "string" && headers["user-agent"].trim() !== ""
        ? (headers["user-agent"] as string)
        : "unknown-device";

  return hashDeviceFingerprint(source);
}

export interface NewDeviceLoginInput {
  walletAddress: string;
  deviceSummary: string;
  /** Coarse location only, e.g. "London, UK" — never an IP or address. */
  coarseLocation: string;
  occurredAt?: Date;
  ipAddress?: string;
  reviewSessionsUrl?: string;
}

export interface NewDeviceLoginResult {
  emailSent: boolean;
  inAppSent: boolean;
}

export interface RegisterLoginDeviceInput {
  walletAddress: string;
  /** Hashed device fingerprint (see {@link deviceFingerprintFromHeaders}). */
  fingerprint: string;
  userAgent?: string;
  coarseLocation: string;
  ipAddress?: string;
  occurredAt?: Date;
}

export interface RegisterLoginDeviceResult extends NewDeviceLoginResult {
  sessionId: string;
  deviceSummary: string;
  newDevice: boolean;
}

/**
 * Record a successful login as a session and notify the user when this
 * fingerprint has not been seen for the wallet before. Returns the session id
 * for the token's `sid` claim.
 */
export async function registerLoginDevice(
  input: RegisterLoginDeviceInput
): Promise<RegisterLoginDeviceResult> {
  const knownDevice = isKnownDevice(input.walletAddress, input.fingerprint);
  const session = createUserSession({
    walletAddress: input.walletAddress,
    userAgent: input.userAgent,
    coarseLocation: input.coarseLocation,
    deviceFingerprint: input.fingerprint,
  });

  if (knownDevice) {
    return {
      sessionId: session.sessionId,
      deviceSummary: session.deviceSummary,
      newDevice: false,
      emailSent: false,
      inAppSent: false,
    };
  }

  const notification = await notifyNewDeviceLogin({
    walletAddress: input.walletAddress,
    deviceSummary: session.deviceSummary,
    coarseLocation: input.coarseLocation,
    occurredAt: input.occurredAt ?? new Date(session.createdAt),
    ipAddress: input.ipAddress,
  });

  return {
    sessionId: session.sessionId,
    deviceSummary: session.deviceSummary,
    newDevice: true,
    ...notification,
  };
}

async function resolveEmail(walletAddress: string): Promise<{
  address: string;
  enabled: boolean;
}> {
  const preference = await getNotificationPreference(walletAddress).catch(() => null);
  const address = preference?.email || `${walletAddress}@example.com`;

  try {
    const matrix = await getCommunicationPreferences(walletAddress);
    return { address, enabled: matrix.SECURITY.EMAIL.enabled };
  } catch {
    // The matrix is unavailable (or the applicant cannot be resolved) —
    // fall back to the legacy global email toggle rather than blocking the
    // security email entirely.
    return { address, enabled: preference?.emailAlerts ?? true };
  }
}

/**
 * Send the first-login alert. Never throws: a notification failure must not
 * fail the login the user is in the middle of.
 */
export async function notifyNewDeviceLogin(
  input: NewDeviceLoginInput
): Promise<NewDeviceLoginResult> {
  const occurredAt = input.occurredAt ?? new Date();
  const reviewSessionsUrl = input.reviewSessionsUrl ?? REVIEW_SESSIONS_PATH;
  const when = occurredAt.toISOString();
  const safeDevice = escapeHtml(input.deviceSummary);
  const safeLocation = escapeHtml(input.coarseLocation);
  const summary =
    `A new device signed in to your account.\n\n` +
    `Device: ${input.deviceSummary}\n` +
    `Location: ${input.coarseLocation}\n` +
    `Time: ${when}\n\n` +
    `If this was you, no action is needed. If it wasn't, review your active ` +
    `sessions and revoke the device: ${reviewSessionsUrl}`;

  let inAppSent = false;
  try {
    await createInAppNotification({
      walletAddress: input.walletAddress,
      title: "New device signed in",
      message: summary,
      variant: "warning",
      metadata: {
        event: "login.device.new",
        deviceSummary: input.deviceSummary,
        coarseLocation: input.coarseLocation,
        occurredAt: when,
        reviewSessionsUrl,
      },
    });
    inAppSent = true;
  } catch (err) {
    logger.error("[new-device-login] failed to create in-app notification", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let emailSent = false;
  try {
    const { address, enabled } = await resolveEmail(input.walletAddress);
    if (enabled) {
      const html = getBrandedHtml(
        "New device signed in",
        `
          <h2>New device signed in</h2>
          <p>A device we haven't seen before signed in to your account.</p>
          <ul>
            <li><strong>Device:</strong> ${safeDevice}</li>
            <li><strong>Coarse location:</strong> ${safeLocation}</li>
            <li><strong>Time:</strong> ${when}</li>
          </ul>
          <p>If this was you, you can ignore this message. If it wasn't,
             <a href="${reviewSessionsUrl}">review your active sessions</a> and
             revoke the device.</p>
        `
      );
      emailSent = await sendEmail(address, "New device signed in to your account", html);
    }
  } catch (err) {
    logger.error("[new-device-login] failed to send notification email", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await logAudit({
    action: "login.device.new",
    actorAddress: input.walletAddress,
    ipAddress: input.ipAddress,
    metadata: {
      deviceSummary: input.deviceSummary,
      coarseLocation: input.coarseLocation,
      occurredAt: when,
      emailSent,
      inAppSent,
    },
  }).catch(() => undefined);

  return { emailSent, inAppSent };
}
