// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  initiateAdmin2FASetup,
  enableAdmin2FA,
  authenticateAdmin2FA,
  getAdmin2FAStatus,
  disableAdmin2FA,
} from "../services/totpAuth.js";
import logger from "../utils/logger.js";

export const adminAuthRouter = Router();

/**
 * @openapi
 * /api/admin/2fa/status:
 *   get:
 *     summary: Get TOTP 2FA configuration status for current admin account
 *     tags: [Admin 2FA]
 */
adminAuthRouter.get("/2fa/status", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const adminAddress = req.user?.walletAddress || process.env.ADMIN_WALLET_ADDRESS || "admin";
  const status = getAdmin2FAStatus(adminAddress);
  return res.json(status);
});

/**
 * @openapi
 * /api/admin/2fa/setup:
 *   post:
 *     summary: Generate TOTP secret and enrollment QR code for admin account
 *     tags: [Admin 2FA]
 */
adminAuthRouter.post("/2fa/setup", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const adminAddress = req.user?.walletAddress || process.env.ADMIN_WALLET_ADDRESS || "admin";
  const enrollment = initiateAdmin2FASetup(adminAddress);

  return res.json({
    message: "TOTP 2FA secret generated. Scan QR code and verify with code to enable.",
    secret: enrollment.secret,
    otpauthUrl: enrollment.otpauthUrl,
    qrCodeUrl: enrollment.qrCodeUrl,
    recoveryCodes: enrollment.recoveryCodes,
  });
});

/**
 * @openapi
 * /api/admin/2fa/enable:
 *   post:
 *     summary: Verify TOTP token and enable 2FA for admin account
 *     tags: [Admin 2FA]
 */
adminAuthRouter.post("/2fa/enable", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const adminAddress = req.user?.walletAddress || process.env.ADMIN_WALLET_ADDRESS || "admin";
  const { secret, token, recoveryCodes } = req.body;

  if (!secret || !token || !Array.isArray(recoveryCodes)) {
    return res.status(400).json({
      error: "invalid_request",
      message: "secret, token, and recoveryCodes are required",
    });
  }

  const result = enableAdmin2FA(adminAddress, secret, token, recoveryCodes);
  if (!result.success) {
    return res.status(400).json({ error: "verification_failed", message: result.message });
  }

  return res.json({ success: true, message: result.message });
});

/**
 * @openapi
 * /api/admin/2fa/verify:
 *   post:
 *     summary: Authenticate admin action or login using TOTP code or single-use Backup Recovery Code
 *     tags: [Admin 2FA]
 */
adminAuthRouter.post("/2fa/verify", (req: Request, res: Response) => {
  const { adminAddress, code } = req.body;

  if (!adminAddress || !code) {
    return res.status(400).json({
      error: "invalid_request",
      message: "adminAddress and authentication code are required",
    });
  }

  const result = authenticateAdmin2FA(adminAddress, code);

  if (!result.authenticated) {
    return res.status(401).json({
      error: "2fa_authentication_failed",
      message: result.error,
      remainingAttempts: result.remainingAttempts,
    });
  }

  return res.json({
    success: true,
    authenticated: true,
    method: result.method || "none",
    message: result.method
      ? `Successfully authenticated via ${result.method === "totp" ? "TOTP code" : "backup recovery code"}`
      : "2FA not required",
  });
});

/**
 * @openapi
 * /api/admin/2fa/disable:
 *   post:
 *     summary: Disable 2FA for admin account
 *     tags: [Admin 2FA]
 */
adminAuthRouter.post("/2fa/disable", requireAdmin, (req: AuthenticatedRequest, res: Response) => {
  const adminAddress = req.user?.walletAddress || process.env.ADMIN_WALLET_ADDRESS || "admin";
  const { code } = req.body;

  if (code) {
    const authCheck = authenticateAdmin2FA(adminAddress, code);
    if (!authCheck.authenticated) {
      return res.status(401).json({ error: "invalid_code", message: "Invalid 2FA code to confirm disable" });
    }
  }

  disableAdmin2FA(adminAddress);
  return res.json({ success: true, message: "2FA disabled successfully" });
});
