import { Router, Request, Response } from "express";
import { joinWaitlist, getWaitlistPosition } from "../services/inviteCode.js";
import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

export const waitlistRouter = Router();

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * @openapi
 * /api/waitlist:
 *   post:
 *     summary: Join waitlist for soft-launch markets
 *     tags:
 *       - Waitlist
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               walletAddress:
 *                 type: string
 *     responses:
 *       201:
 *         description: Added to waitlist
 *       400:
 *         description: Invalid email
 */
waitlistRouter.post("/", async (req: Request, res: Response) => {
  const { email, walletAddress } = req.body ?? {};
  if (!email || typeof email !== "string" || !isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_request", message: "valid email is required" });
  }
  try {
    const { entry, position, total } = await joinWaitlist(email, walletAddress);
    const isNew = entry.createdAt && Date.now() - new Date(entry.createdAt).getTime() < 2000;
    return res.status(isNew ? 201 : 200).json({
      email: entry.email,
      position,
      total,
      status: entry.status,
    });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // unique constraint race - fetch existing
      const position = await getWaitlistPosition(email);
      const total = await prisma.waitlistEntry.count();
      return res.status(200).json({ email: email.toLowerCase(), position, total, status: "pending" });
    }
    logger.error("[waitlist] join failed", { err });
    return res.status(500).json({ error: "waitlist_failed" });
  }
});

waitlistRouter.get("/position", async (req: Request, res: Response) => {
  const email = (req.query.email as string) || (req.body as any)?.email;
  if (!email || typeof email !== "string" || !isValidEmail(email)) {
    return res.status(400).json({ error: "invalid_request", message: "valid email query param required" });
  }
  const position = await getWaitlistPosition(email);
  if (position === -1) {
    return res.status(404).json({ error: "not_found", message: "email not on waitlist" });
  }
  const total = await prisma.waitlistEntry.count();
  return res.json({ email: email.toLowerCase(), position, total });
});
