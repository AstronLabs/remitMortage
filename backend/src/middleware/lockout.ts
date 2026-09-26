// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import { isLockedOut } from "../services/lockoutService.js";

/**
 * Express middleware to prevent brute-force login attempts when an account/IP is locked out.
 */
export async function loginLockoutGuard(req: Request, res: Response, next: NextFunction) {
  const identifier = (
    req.body?.email ||
    req.body?.walletAddress ||
    req.body?.username ||
    req.ip ||
    "unknown"
  ).toString();

  try {
    const status = await isLockedOut(identifier);
    if (status.locked) {
      return res.status(429).json({
        error: "account_locked",
        message: `Account is temporarily locked due to repeated failed login attempts. Please try again in ${status.remainingSeconds} seconds.`,
        remainingSeconds: status.remainingSeconds,
        lockedUntilMs: status.lockedUntilMs,
      });
    }

    next();
  } catch (err) {
    // If lockout check fails unexpectedly, allow request to proceed but log warning
    next();
  }
}
