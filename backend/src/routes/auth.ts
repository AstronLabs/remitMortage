import { Router, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { isInviteRequired, validateInviteCode, consumeInviteCode } from "../services/inviteCode.js";
import { upsertApplicant } from "../services/db.js";
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
authRouter.post("/register", async (req: Request, res: Response) => {
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

    const token = jwt.sign(
      { walletAddress, email: email || null },
      process.env.JWT_SECRET || "default_jwt_secret",
      { expiresIn: "24h" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
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
