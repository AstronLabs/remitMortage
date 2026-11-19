// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Adaptive CAPTCHA gate (issue #934). Passes normal traffic straight through;
 * when risk signals are present for the source it demands a server-verified,
 * single-use token bound to this action. Failed attempts feed the risk signal.
 */

import type { Request, Response, NextFunction } from "express";
import {
  assessRisk,
  issueChallenge,
  recordFailure,
  recordRequest,
  verifyCaptchaToken,
} from "../services/adaptiveCaptcha.js";
import logger from "../utils/logger.js";

export function captchaTokenFromRequest(req: Request): string | undefined {
  const header = req.headers["x-captcha-token"];
  if (typeof header === "string" && header) return header;
  const body = req.body?.captchaToken;
  return typeof body === "string" && body ? body : undefined;
}

export function sourceFromRequest(req: Request): string {
  return req.ip || "unknown";
}

export function adaptiveCaptcha(action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const source = sourceFromRequest(req);
    const asn = req.headers["x-asn"];
    const fingerprint = req.headers["x-device-fingerprint"];
    const ctx = {
      action,
      source,
      asn: typeof asn === "string" ? asn : undefined,
      fingerprint: typeof fingerprint === "string" ? fingerprint : undefined,
    };

    const risk = assessRisk(ctx);
    recordRequest(ctx);

    let challengeIssued = false;
    res.on("finish", () => {
      if (!challengeIssued && res.statusCode >= 400 && res.statusCode < 500) recordFailure(ctx);
    });

    if (!risk.risky) {
      next();
      return;
    }

    const verdict = verifyCaptchaToken(captchaTokenFromRequest(req), action, source);
    if (verdict.valid) {
      next();
      return;
    }

    challengeIssued = true;
    logger.warn("[security] captcha required", { action, source, reasons: risk.reasons, tokenProblem: verdict.reason });
    res.status(403).json({
      error: "captcha_required",
      message:
        "We noticed unusual activity. Please complete the verification challenge. If you cannot, use the assisted option or contact support.",
      reasons: risk.reasons,
      tokenProblem: verdict.reason,
      challenge: issueChallenge({ action, source }),
      supportContact: process.env.CAPTCHA_SUPPORT_CONTACT ?? "support@remitmortgage.com",
    });
  };
}
