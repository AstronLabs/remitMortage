// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, type Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import { signSessionToken } from "../services/jwtKeyRing.js";
import {
  DeviceEnrolmentError,
  deviceBindingMode,
  enrollAdminDevice,
  listAdminDevices,
  revokeAdminDevice,
} from "../services/adminDeviceBinding.js";
import { logAudit } from "../services/audit.js";
import logger from "../utils/logger.js";

export const adminDevicesRouter = Router();

/** Session cookie lifetime, matching the one `/api/auth/register` issues. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function adminAddressOf(req: AuthenticatedRequest): string {
  return (
    req.user?.walletAddress ||
    process.env.ADMIN_WALLET_ADDRESS ||
    "admin"
  ).toLowerCase();
}

/**
 * @openapi
 * /api/admin/devices/enroll:
 *   post:
 *     summary: Bind the current admin session to this device
 *     description: >-
 *       Registers a device-held Ed25519 public key and re-issues the admin
 *       session cookie with a `dbk` claim committing it to that key (issue
 *       #886). Every later admin request must carry a signature from the
 *       matching private key, so a copied cookie is useless elsewhere.
 *       This is the one admin endpoint reachable on an unbound session.
 *     tags:
 *       - Admin Devices
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [publicKey]
 *             properties:
 *               publicKey:
 *                 type: string
 *                 description: Base64-encoded 32-byte Ed25519 public key.
 *               label:
 *                 type: string
 *                 description: Human label for the device list.
 *     responses:
 *       201:
 *         description: Device enrolled and the session rebound to it.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AdminDeviceEnrollmentResponse'
 *       400:
 *         description: The public key or label was rejected.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: No admin session.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
adminDevicesRouter.post(
  "/devices/enroll",
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const adminAddress = adminAddressOf(req);
    const { publicKey, label } = (req.body ?? {}) as {
      publicKey?: unknown;
      label?: unknown;
    };

    if (typeof publicKey !== "string" || publicKey.trim() === "") {
      return res.status(400).json({
        error: "invalid_request",
        message: "publicKey is required",
      });
    }

    try {
      const device = enrollAdminDevice({
        adminAddress,
        publicKey,
        label: typeof label === "string" ? label : undefined,
      });

      // Re-issuing the cookie is what actually binds the session: the new
      // token commits to this device's fingerprint, and the old token — which
      // did not — is replaced in the browser.
      const token = signSessionToken(
        { walletAddress: adminAddress, dbk: device.fingerprint },
        { expiresIn: "24h" }
      );

      res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: SESSION_TTL_MS,
      });

      void logAudit({
        action: "admin.device_binding.enrolled",
        actorAddress: adminAddress,
        ipAddress: req.ip,
        metadata: {
          deviceId: device.deviceId,
          fingerprint: device.fingerprint,
          label: device.label,
          userAgent: req.headers["user-agent"] ?? null,
        },
      });

      return res.status(201).json({
        deviceId: device.deviceId,
        fingerprint: device.fingerprint,
        label: device.label,
        createdAt: device.createdAt.toISOString(),
        mode: deviceBindingMode(),
        bound: true,
      });
    } catch (error) {
      if (error instanceof DeviceEnrolmentError) {
        return res.status(400).json({ error: error.code, message: error.message });
      }
      logger.error("[admin-devices] enrolment failed", { error });
      return res.status(500).json({ error: "enrollment_failed" });
    }
  }
);

/**
 * @openapi
 * /api/admin/devices:
 *   get:
 *     summary: List devices bound to the current admin account
 *     tags:
 *       - Admin Devices
 *     responses:
 *       200:
 *         description: Enrolled devices, newest first.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AdminDeviceListResponse'
 *       401:
 *         description: No admin session, or the session's device proof failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
adminDevicesRouter.get("/devices", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const adminAddress = adminAddressOf(req);
  const devices = listAdminDevices(adminAddress);

  return res.json({
    mode: deviceBindingMode(),
    boundFingerprint: req.user?.deviceFingerprint ?? null,
    devices: devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      fingerprint: device.fingerprint,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
      revokedAt: device.revokedAt ? device.revokedAt.toISOString() : null,
      current: device.fingerprint === req.user?.deviceFingerprint,
    })),
  });
});

/**
 * @openapi
 * /api/admin/devices/{deviceId}/revoke:
 *   post:
 *     summary: Revoke a bound admin device
 *     description: >-
 *       Any session bound to the revoked device fails its next request and
 *       must re-authenticate. Use this the moment a device is lost.
 *     tags:
 *       - Admin Devices
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Device revoked.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AdminDeviceRevokeResponse'
 *       401:
 *         description: No admin session, or the session's device proof failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       404:
 *         description: No such device for this admin account.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
adminDevicesRouter.post(
  "/devices/:deviceId/revoke",
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    const adminAddress = adminAddressOf(req);
    const deviceId = String(req.params.deviceId);
    const reason =
      typeof (req.body ?? {}).reason === "string" ? String(req.body.reason) : "revoked_by_admin";

    const device = revokeAdminDevice(deviceId, adminAddress, reason);
    if (!device) {
      // Same answer whether the id is unknown or belongs to another admin, so
      // the endpoint is not a device-id oracle.
      return res.status(404).json({ error: "device_not_found", message: "No such device" });
    }

    void logAudit({
      action: "admin.device_binding.revoked",
      actorAddress: adminAddress,
      ipAddress: req.ip,
      metadata: { deviceId: device.deviceId, label: device.label, reason },
    });

    return res.json({
      deviceId: device.deviceId,
      label: device.label,
      revokedAt: device.revokedAt ? device.revokedAt.toISOString() : null,
      revokedReason: device.revokedReason,
    });
  }
);
