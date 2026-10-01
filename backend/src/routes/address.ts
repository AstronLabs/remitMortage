// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Applicant mailing address submission/verification (issue #791). Mounted at
 * `/api/address` with `authMiddleware` applied at the mount point in
 * index.ts, so every route here has a verified `req.user.walletAddress`.
 */

import { Router, Response } from "express";
import logger from "../utils/logger.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  AddressValidationError,
  getAddressVerificationStatus,
  verifyAndPersistAddress,
} from "../services/addressVerification.js";

export const addressRouter = Router();

/**
 * GET /api/address
 * Returns the caller's currently stored address and its verification status,
 * or null if no address has ever been submitted.
 */
addressRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const address = await getAddressVerificationStatus(walletAddress);
    return res.json({ address });
  } catch (error) {
    logger.error("[address] Failed to fetch address", { error });
    return res.status(500).json({ error: "address_verification_unavailable" });
  }
});

/**
 * POST /api/address
 * Submits (or resubmits) the caller's mailing address for verification.
 * Body: { line1, line2?, city, state, postalCode, country }
 *
 * Always returns 200 with a status — a submission is never silently
 * accepted or silently rejected. `status` is one of:
 *   STANDARDIZED | NEEDS_REVIEW | UNVERIFIED
 */
addressRouter.post("/", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const outcome = await verifyAndPersistAddress(walletAddress, req.body ?? {});
    return res.json(outcome);
  } catch (error) {
    if (error instanceof AddressValidationError) {
      return res.status(400).json({ error: "invalid_address", message: error.message });
    }
    logger.error("[address] Failed to verify address", { error });
    return res.status(500).json({ error: "address_verification_unavailable" });
  }
});
