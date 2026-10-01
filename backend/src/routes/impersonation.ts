import { Router, Response } from "express";
import jwt from "jsonwebtoken";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import { sensitiveRateLimiter } from "../middleware/rateLimit.js";
import { isValidGAddress } from "../middleware/validate.js";
import { prisma } from "../services/db.js";
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_SESSION_TTL_MS,
  endImpersonation,
  getImpersonationStatus,
  startImpersonation,
  type ImpersonationClaims,
} from "../services/impersonation.js";
import logger from "../utils/logger.js";

export const impersonationRouter = Router();

/**
 * @openapi
 * /api/admin/impersonate/start:
 *   post:
 *     summary: Start a read-only "view as user" support session
 *     description: >-
 *       Issues a scoped, time-limited (15 minute), read-only session token
 *       for the given wallet, set as a separate cookie from the admin's own
 *       session so their admin login is never replaced. Every mutating
 *       request made while this session is active is rejected at the
 *       middleware layer, and the session's start is recorded in the audit
 *       trail immediately.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 */
impersonationRouter.post(
  "/impersonate/start",
  sensitiveRateLimiter,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const adminAddress = req.user?.walletAddress;
    const { targetWallet, reason } = req.body ?? {};

    if (!adminAddress) {
      return res.status(403).json({ error: "forbidden", message: "Admin identity is required" });
    }

    if (!isValidGAddress(targetWallet)) {
      return res.status(400).json({
        error: "invalid_address",
        field: "targetWallet",
        message: "targetWallet must be a valid Stellar G-address",
      });
    }

    if (targetWallet.toLowerCase() === adminAddress.toLowerCase()) {
      return res.status(400).json({
        error: "invalid_target",
        message: "Cannot impersonate your own wallet",
      });
    }

    try {
      const { token, sessionId, expiresAt } = await startImpersonation({
        adminAddress,
        targetAddress: targetWallet,
        ipAddress: req.ip,
        reason: typeof reason === "string" ? reason.slice(0, 500) : undefined,
      });

      res.cookie(IMPERSONATION_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: IMPERSONATION_SESSION_TTL_MS,
      });

      return res.status(201).json({
        sessionId,
        targetWallet,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      logger.error("[impersonation] failed to start session", { error, adminAddress, targetWallet });
      return res.status(500).json({ error: "impersonation_start_failed" });
    }
  }
);

/**
 * @openapi
 * /api/admin/impersonate/end:
 *   post:
 *     summary: End the caller's active read-only impersonation session
 *     description: >-
 *       Clears the impersonation cookie and records the session's end time
 *       (and derived duration) in the audit trail. Ending an already-ended
 *       or nonexistent session is a no-op, not an error, so the "leave
 *       impersonation" banner action is always safe to click.
 *     tags:
 *       - Admin
 *     security:
 *       - bearerAuth: []
 */
impersonationRouter.post(
  "/impersonate/end",
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    const adminAddress = req.user?.walletAddress;
    if (!adminAddress) {
      return res.status(403).json({ error: "forbidden", message: "Admin identity is required" });
    }

    const { sessionId: requestedSessionId } = req.body ?? {};

    try {
      const sessionId =
        typeof requestedSessionId === "string" && requestedSessionId
          ? requestedSessionId
          : (
              await prisma.impersonationSession.findFirst({
                where: { adminAddress, endedAt: null, expiresAt: { gt: new Date() } },
                orderBy: { startedAt: "desc" },
              })
            )?.id;

      if (sessionId) {
        await endImpersonation({ sessionId, endedBy: adminAddress });
      }

      res.clearCookie(IMPERSONATION_COOKIE);
      return res.json({ ended: true });
    } catch (error) {
      logger.error("[impersonation] failed to end session", { error, adminAddress });
      return res.status(500).json({ error: "impersonation_end_failed" });
    }
  }
);

/**
 * @openapi
 * /api/admin/impersonate/status:
 *   get:
 *     summary: Report whether the caller currently holds an active impersonation session
 *     description: >-
 *       Reads only the impersonation cookie (not the caller's own login), so
 *       the frontend banner can render for whoever's browser is holding it —
 *       which, mid-session, is no longer resolvable as "the admin" through
 *       the normal auth path. Reveals nothing to a browser not holding that
 *       cookie.
 *     tags:
 *       - Admin
 */
impersonationRouter.get("/impersonate/status", async (req, res) => {
  const token = req.cookies?.[IMPERSONATION_COOKIE];
  if (!token) {
    return res.json({ active: false, sessionId: null, adminAddress: null, targetAddress: null, startedAt: null, expiresAt: null });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default_jwt_secret") as ImpersonationClaims;
    const status = await getImpersonationStatus(decoded.impersonation.sessionId);
    return res.json(status);
  } catch {
    return res.json({ active: false, sessionId: null, adminAddress: null, targetAddress: null, startedAt: null, expiresAt: null });
  }
});
