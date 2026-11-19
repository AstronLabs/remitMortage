// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Device-binding enforcement for admin sessions (issue #886).
 *
 * Mounted directly after `authMiddleware` on every `/api/admin` router, so a
 * session cookie alone is never enough to reach an admin handler. The crypto
 * and the store live in `services/adminDeviceBinding.ts`; this file is the
 * HTTP contract around it:
 *
 *   200  valid proof from the bound device
 *   401  `device_binding_failed` + `reauthRequired: true`, session cookie cleared
 *   401  `device_binding_required` when the session carries no `dbk` claim
 *
 * Both 401s clear the session cookie. That is the "require re-authentication"
 * half of the issue: a session whose binding fails or changed is not merely
 * refused for this request, it stops being a session at all, so a thief cannot
 * retry against a different endpoint.
 *
 * Deliberately *not* enforced for the static admin API key, which is a
 * server-to-server credential with no device to bind to. That path is gated by
 * `adminIpAllowlist` instead.
 */

import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import { loadConfig } from "../config.js";
import {
  BINDING_FAILURE_MESSAGES,
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIMESTAMP_HEADER,
  deviceBindingMode,
  hashRequestBody,
  verifyDeviceProof,
  type BindingFailureReason,
  type BindingMode,
} from "../services/adminDeviceBinding.js";
import { logAudit } from "../services/audit.js";
import { getBrandedHtml, sendEmail } from "../services/email.js";
import { adminDeviceBindingFailuresTotal } from "../services/metrics.js";
import logger from "../utils/logger.js";

/**
 * Paths (relative to the router mount) that work on an unbound session.
 * Enrolment has to be reachable before a device exists, or an admin could
 * never bind their first device.
 */
const UNBOUND_PATHS = new Set(["/devices/enroll"]);

/**
 * Marks a request whose proof has already been checked.
 *
 * `index.ts` mounts several routers at `/api/admin`, each behind this guard, so
 * Express runs the guard once per mount until one of them matches the path. A
 * proof's nonce is single-use, so the second run would report `replayed_proof`
 * against the caller's own valid request. The memo makes the guard idempotent
 * for the lifetime of a request — and saves the repeated signature check.
 */
const VERIFIED = Symbol("remitmortgage.deviceBindingVerified");

function alreadyVerified(req: AuthenticatedRequest): boolean {
  return (req as unknown as Record<symbol, boolean>)[VERIFIED] === true;
}

function markVerified(req: AuthenticatedRequest): void {
  (req as unknown as Record<symbol, boolean>)[VERIFIED] = true;
}

/** One notification per admin per window, so a replay storm is not a mail flood. */
const NOTIFY_THROTTLE_MS = 10 * 60 * 1000;
const lastNotifiedAt = new Map<string, number>();

/** Test hook: clears the notification throttle. */
export function _resetBindingNotificationThrottle(): void {
  lastNotifiedAt.clear();
}

function isUnboundPath(req: AuthenticatedRequest): boolean {
  if (UNBOUND_PATHS.has(req.path)) return true;
  // Also match when the middleware is mounted at the app root rather than on
  // the router, so wiring order cannot accidentally lock out enrolment.
  return [...UNBOUND_PATHS].some((path) => (req.originalUrl || "").split("?")[0].endsWith(path));
}

/** True when the caller presented the static admin API key. */
function usesAdminApiKey(req: AuthenticatedRequest): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  return header.slice(7) === loadConfig().adminApiKey;
}

/**
 * Serialises the parsed body back to the exact bytes the client hashed.
 *
 * `JSON.stringify` of a parsed body is not byte-identical to what the client
 * sent in general, so a client must hash `JSON.stringify(payload)` of the same
 * object it sends — which is what the browser helper does. For a body-less
 * request both sides hash the empty string.
 */
function bodyHashFor(req: AuthenticatedRequest): string {
  const body = req.body as unknown;
  if (body === undefined || body === null) return hashRequestBody("");
  if (typeof body === "string") return hashRequestBody(body);
  if (Buffer.isBuffer(body)) return hashRequestBody(body);
  if (typeof body === "object" && Object.keys(body as object).length === 0) {
    return hashRequestBody("");
  }
  return hashRequestBody(JSON.stringify(body));
}

async function recordFailure(
  req: AuthenticatedRequest,
  reason: BindingFailureReason,
  mode: BindingMode
): Promise<void> {
  const adminAddress = req.user?.walletAddress ?? "unknown";
  const presentedDeviceId = String(req.headers[DEVICE_ID_HEADER] ?? "none");

  adminDeviceBindingFailuresTotal.inc({ reason, mode });

  logger.warn("[device-binding] admin request rejected", {
    reason,
    mode,
    adminAddress,
    presentedDeviceId,
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip,
  });

  await logAudit({
    action: "admin.device_binding.failed",
    actorAddress: adminAddress,
    ipAddress: req.ip,
    metadata: {
      reason,
      mode,
      presentedDeviceId,
      method: req.method,
      path: req.originalUrl || req.url,
      userAgent: req.headers["user-agent"] ?? null,
    },
  });

  // A mismatch or a replay is someone using a session from a machine it was
  // not issued to — the admin hears about that. Clock skew and a not-yet-bound
  // session are operational noise and stay in the audit trail only.
  const alarming: BindingFailureReason[] = [
    "device_mismatch",
    "replayed_proof",
    "unknown_device",
    "device_owner_mismatch",
    "invalid_signature",
  ];
  if (!alarming.includes(reason)) return;

  const now = Date.now();
  const previous = lastNotifiedAt.get(adminAddress) ?? 0;
  if (now - previous < NOTIFY_THROTTLE_MS) return;
  lastNotifiedAt.set(adminAddress, now);

  try {
    const { adminAlertEmail } = loadConfig();
    if (!adminAlertEmail) return;
    await sendEmail(
      adminAlertEmail,
      "Admin session rejected from an unrecognised device",
      getBrandedHtml(
        "Admin session rejected",
        `
        <h2>An admin session was used from an unrecognised device</h2>
        <p>A request to <strong>${req.method} ${req.originalUrl || req.url}</strong>
           presented a valid admin session cookie, but could not prove it came
           from a device enrolled for that account.</p>
        <p>Reason: <strong>${reason}</strong>. Source IP: <strong>${req.ip ?? "unknown"}</strong>.</p>
        <p>The request was rejected and the session invalidated — no admin
           action took place. If this was not you, the session cookie should be
           treated as compromised: sign in again from a device you trust and
           revoke any device you do not recognise under Admin → Devices.</p>
      `
      )
    );
  } catch (error) {
    logger.error("[device-binding] failed to send notification email", { error });
  }
}

/** Clears the session cookie, so a failed binding forces a fresh login. */
function clearSession(res: Response): void {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
  });
}

/**
 * Requires a valid device proof on every admin request whose session is bound
 * to a device. See the module comment for the response contract.
 */
export function requireBoundDevice() {
  return function boundDevice(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    // A second mount at the same path must not re-check — and re-burn — the
    // nonce this request already spent.
    if (alreadyVerified(req)) {
      next();
      return;
    }

    const mode = deviceBindingMode();
    if (mode === "off") {
      markVerified(req);
      next();
      return;
    }

    // Server-to-server admin API key: no device, nothing to bind.
    if (usesAdminApiKey(req)) {
      markVerified(req);
      next();
      return;
    }

    // Enrolment itself must work on an unbound session.
    if (isUnboundPath(req)) {
      markVerified(req);
      next();
      return;
    }

    const sessionFingerprint = req.user?.deviceFingerprint;

    if (!sessionFingerprint) {
      void recordFailure(req, "binding_not_configured", mode);
      if (mode === "monitor") {
        markVerified(req);
        next();
        return;
      }
      res.status(401).json({
        error: "device_binding_required",
        message: BINDING_FAILURE_MESSAGES.binding_not_configured,
        reauthRequired: true,
        enrollPath: "/api/admin/devices/enroll",
      });
      return;
    }

    const result = verifyDeviceProof({
      adminAddress: req.user?.walletAddress ?? "",
      sessionFingerprint,
      deviceId: req.headers[DEVICE_ID_HEADER],
      timestamp: req.headers[DEVICE_TIMESTAMP_HEADER],
      nonce: req.headers[DEVICE_NONCE_HEADER],
      signature: req.headers[DEVICE_SIGNATURE_HEADER],
      method: req.method,
      path: (req.originalUrl || req.url).split("?")[0],
      bodyHash: bodyHashFor(req),
    });

    if (result.ok) {
      markVerified(req);
      next();
      return;
    }

    void recordFailure(req, result.reason, mode);

    if (mode === "monitor") {
      markVerified(req);
      next();
      return;
    }

    clearSession(res);
    res.status(401).json({
      error: "device_binding_failed",
      reason: result.reason,
      message: BINDING_FAILURE_MESSAGES[result.reason],
      reauthRequired: true,
    });
  };
}
