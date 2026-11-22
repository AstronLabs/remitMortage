// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import {
  SanctionsHoldError,
  assertSanctionsClear,
} from "../services/sanctionsScreening.js";
import type { SanctionsPartyType } from "../services/sanctionsProvider.js";
import logger from "../utils/logger.js";

/**
 * Sends the standard "account under review" response when `err` is a
 * sanctions hold. Returns false for any other error so the caller can handle
 * it. The body never says why: that would tip off a sanctioned party.
 */
export function respondToSanctionsHold(res: Response, err: unknown): boolean {
  if (!(err instanceof SanctionsHoldError)) return false;
  res.status(err.httpStatus).json({ error: err.code, message: err.message });
  return true;
}

/**
 * Express guard: blocks a party whose sanctions screening is not clear.
 * A no-op while sanctions screening is disabled. A screening store that
 * cannot be read blocks the request (fails closed).
 */
export function requireSanctionsClear(partyType: SanctionsPartyType) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const walletAddress = req.user?.walletAddress;
    if (!walletAddress) return res.status(401).json({ error: "unauthorized" });
    try {
      await assertSanctionsClear(partyType, walletAddress);
      return next();
    } catch (err) {
      if (respondToSanctionsHold(res, err)) return;
      logger.error("[sanctions] Gate check failed", { err });
      return res.status(503).json({ error: "screening_unavailable" });
    }
  };
}
