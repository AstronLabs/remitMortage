// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Accredited-investor re-verification HTTP surface (issue #725).
 *
 * Investor endpoints live under /api/investor (JWT-scoped to the caller):
 *   GET  /api/investor/accreditation          — re-verification status/deadlines
 *   POST /api/investor/investments/authorize  — gate called before any NEW
 *                                               investment; 403 once lapsed
 *
 * Operator endpoint lives under /api/admin:
 *   POST /api/admin/investors/:address/accreditation — record a (re-)verification
 */

import { NextFunction, Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  InvestmentRestrictedError,
  assertInvestmentAllowed,
  getReverificationState,
  recordInvestorVerification,
} from "../services/investorReverification.js";
import logger from "../utils/logger.js";

export const investorRouter = Router();
export const investorAdminRouter = Router();

/**
 * Express guard for routes that start a NEW investment. Existing-holding
 * routes (withdraw, claim) must not use it.
 */
export async function requireCurrentAccreditation(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    await assertInvestmentAllowed(walletAddress);
    return next();
  } catch (err) {
    if (err instanceof InvestmentRestrictedError) {
      return res.status(err.httpStatus).json({ error: err.code, message: err.message, ...err.state });
    }
    logger.error("[investor] Accreditation check failed", { err });
    return res.status(500).json({ error: "accreditation_check_failed" });
  }
}

investorRouter.get("/accreditation", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    return res.json(await getReverificationState(walletAddress));
  } catch (err) {
    logger.error("[investor] Failed to read accreditation status", { err });
    return res.status(500).json({ error: "accreditation_unavailable" });
  }
});

investorRouter.post(
  "/investments/authorize",
  requireCurrentAccreditation,
  (_req: AuthenticatedRequest, res: Response) => res.json({ allowed: true })
);

investorAdminRouter.post(
  "/investors/:address/accreditation",
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const address = String(req.params?.address ?? "").trim();
    if (!address) {
      return res.status(400).json({ error: "invalid_address" });
    }
    const raw = (req.body ?? {}).verifiedAt;
    const verifiedAt = raw === undefined ? new Date() : new Date(raw);
    if (Number.isNaN(verifiedAt.getTime()) || verifiedAt.getTime() > Date.now()) {
      return res.status(400).json({ error: "invalid_verified_at" });
    }
    try {
      await recordInvestorVerification(address, verifiedAt);
      return res.status(201).json(await getReverificationState(address));
    } catch (err) {
      logger.error("[investor] Failed to record verification", { err });
      return res.status(500).json({ error: "accreditation_record_failed" });
    }
  }
);
