// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, type Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import { getTrustPeriodDays, setTrustPeriodDays, MAX_TRUST_PERIOD_DAYS } from "../services/trustedDevices.js";
import { logAudit } from "../services/audit.js";

/**
 * Admin control over how long a user-trusted device skips step-up
 * verification (issue #1105).
 */
export const adminTrustedDevicePolicyRouter = Router();

/**
 * @openapi
 * /api/admin/security/trusted-device-policy:
 *   get:
 *     summary: Get the trusted-device step-up skip period
 *     tags: [Admin]
 *     responses:
 *       200:
 *         description: The current trust period in days.
 */
adminTrustedDevicePolicyRouter.get(
  "/security/trusted-device-policy",
  requireAdmin,
  (_req: AuthenticatedRequest, res: Response) => {
    res.json({ trustPeriodDays: getTrustPeriodDays(), maxTrustPeriodDays: MAX_TRUST_PERIOD_DAYS });
  }
);

/**
 * @openapi
 * /api/admin/security/trusted-device-policy:
 *   put:
 *     summary: Set the trusted-device step-up skip period
 *     description: >-
 *       Applies to devices trusted after the change; already-trusted devices
 *       keep the expiry they were granted.
 *     tags: [Admin]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [trustPeriodDays]
 *             properties:
 *               trustPeriodDays: { type: integer, minimum: 1, maximum: 365 }
 *     responses:
 *       200:
 *         description: The updated trust period.
 *       400:
 *         description: trustPeriodDays out of range.
 */
adminTrustedDevicePolicyRouter.put(
  "/security/trusted-device-policy",
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const trustPeriodDays = req.body?.trustPeriodDays;
    try {
      setTrustPeriodDays(trustPeriodDays);
    } catch (error) {
      res.status(400).json({ error: "invalid_trust_period", message: (error as Error).message });
      return;
    }
    await logAudit({
      action: "admin.trusted_device_policy.updated",
      actorAddress: req.user?.walletAddress,
      metadata: { trustPeriodDays },
    });
    res.json({ trustPeriodDays: getTrustPeriodDays(), maxTrustPeriodDays: MAX_TRUST_PERIOD_DAYS });
  }
);
