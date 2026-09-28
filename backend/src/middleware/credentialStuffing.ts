// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Credential-stuffing guard (issue #737).
 *
 * Runs before the per-account lockout check. When the request's correlated
 * source (IP / subnet / ASN / fingerprint) is under adaptive lockout, the
 * request is held for a short step-up delay and challenged (CAPTCHA marker)
 * with 429 — scoped to that source only. Unrelated sources pass through
 * untouched, so there is no blanket block.
 */

import type { Request, Response, NextFunction } from "express";
import { isStuffingSourceLocked } from "../services/credentialStuffing.js";
import logger from "../utils/logger.js";

function sourceContextFromRequest(req: Request): { ip?: string; asn?: string; fingerprint?: string } {
  const asnHeader = req.headers["x-asn"] ?? (req.body?.asn as unknown);
  const fpHeader = req.headers["x-device-fingerprint"] ?? (req.body?.fingerprint as unknown);
  return {
    ip: req.ip,
    asn: typeof asnHeader === "string" ? asnHeader : undefined,
    fingerprint: typeof fpHeader === "string" ? fpHeader : undefined,
  };
}

export async function credentialStuffingGuard(req: Request, res: Response, next: NextFunction) {
  try {
    const status = isStuffingSourceLocked(sourceContextFromRequest(req));
    if (!status.locked) {
      next();
      return;
    }
    const remainingSeconds = status.lockedUntilMs
      ? Math.max(1, Math.ceil((status.lockedUntilMs - Date.now()) / 1000))
      : undefined;
    // Small adaptive delay (step-up friction) before answering.
    const delayMs = Math.min(status.delayMs ?? 0, 250);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    logger.warn("[security] adaptive lockout challenge for stuffing source", {
      sources: status.sources,
      ip: req.ip,
    });
    res.status(429).json({
      error: "source_locked",
      message:
        "Unusual sign-in activity was detected from your network. Please complete the verification challenge and retry shortly.",
      requireCaptcha: true,
      sources: status.sources,
      remainingSeconds,
    });
    return;
  } catch {
    next();
  }
}
