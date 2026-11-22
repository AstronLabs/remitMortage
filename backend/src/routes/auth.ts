// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, Request, Response } from "express";
import { signSessionToken } from "../services/jwtKeyRing.js";
import { loadConfig } from "../config.js";
import { isInviteRequired, validateInviteCode, consumeInviteCode } from "../services/inviteCode.js";
import { upsertApplicant } from "../services/db.js";
import { screenOnboardedParty } from "../services/sanctionsScreening.js";
import { adaptiveCaptcha } from "../middleware/adaptiveCaptcha.js";
import logger from "../utils/logger.js";

export const authRouter = Router();

/**
 * @openapi
 * /api/auth/register:
 *   post:
 *     summary: Register wallet with optional invite code gating
 *     description: >-
 *       When INVITE_CODE_REQUIRED=true, requires a valid unused invite code.
 *       Code is consumed exactly once on success.
 *     tags:
 *       - Auth
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [walletAddress]
 *             properties:
 *               walletAddress:
 *                 type: string
 *               email:
 *                 type: string
 *               inviteCode:
 *                 type: string
 *     responses:
 *       201:
 *         description: Registration successful
 *       400:
 *         description: Missing fields
 *       403:
 *         description: Invite code required or invalid
 */
authRouter.post("/register", adaptiveCaptcha("register"), async (req: Request, res: Response) => {
  const { walletAddress, email, inviteCode } = req.body ?? {};

  if (!walletAddress || typeof walletAddress !== "string") {
    return res.status(400).json({ error: "invalid_request", message: "walletAddress is required" });
  }

  // Gating check - configurable per environment/market via INVITE_CODE_REQUIRED
  if (isInviteRequired()) {
    if (!inviteCode || typeof inviteCode !== "string" || inviteCode.trim() === "") {
      return res.status(403).json({ error: "invite_code_required", message: "invite code is required for registration" });
    }
    const validation = await validateInviteCode(inviteCode);
    if (!validation.valid) {
      return res.status(403).json({ error: "invalid_invite_code", message: validation.reason });
    }
  } else {
    // When gating disabled, if inviteCode is provided validate it but don't block on missing
    if (inviteCode) {
      const validation = await validateInviteCode(inviteCode);
      if (!validation.valid) {
        return res.status(403).json({ error: "invalid_invite_code", message: validation.reason });
      }
    }
  }

  try {
    // Create or update applicant record
    const applicant = await upsertApplicant(walletAddress, {});

    // Screen the new applicant against sanctions lists. A match or an outage
    // is recorded and holds the account; it never blocks registration itself,
    // and a failure here is logged without failing the request.
    try {
      await screenOnboardedParty({ partyType: "APPLICANT", address: walletAddress });
    } catch (screeningErr) {
      logger.error("[auth] sanctions screening at onboarding failed", { screeningErr });
    }

    // Consume invite code if provided (and gating requires it)
    if (inviteCode) {
      const consumed = await consumeInviteCode(inviteCode, walletAddress);
      if (!consumed) {
        // Race: code was used between validate and consume
        return res.status(403).json({ error: "invalid_invite_code", message: "invite code already used" });
      }
      // If waitlist entry exists for email, mark invited->registered
      if (email) {
        try {
          const { prisma } = await import("../services/db.js");
          await prisma.waitlistEntry.updateMany({
            where: { email: email.toLowerCase() },
            data: { status: "registered" },
          });
        } catch {}
      }
    }

    // Signed with the current key of the rotation ring; the token carries that
    // key's `kid` so verification can also accept the previous key during its
    // grace period.
    const { sessionMaxLifetimeMs } = loadConfig();
    const token = signSessionToken(
      { walletAddress, email: email || null },
      { expiresIn: Math.floor(sessionMaxLifetimeMs / 1000) }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: sessionMaxLifetimeMs,
    });

    return res.status(201).json({
      message: "registration successful",
      applicantId: applicant.id,
      walletAddress,
    });
  } catch (err) {
    logger.error("[auth] registration failed", { err });
    return res.status(500).json({ error: "registration_failed" });
  }
});
