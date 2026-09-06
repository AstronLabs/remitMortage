import crypto from "crypto";
import { prisma } from "./db.js";
import logger from "../utils/logger.js";
import { sendGridSend } from "./sendgrid.js";
import { loadConfig } from "../config.js";

export function generateCode(): string {
  // 8-char alphanumeric uppercase, e.g. "A3F9K2P1"
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.randomBytes(8);
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

export async function createInviteCode(email?: string): Promise<{ id: string; code: string }> {
  let code = generateCode();
  // ensure uniqueness (very low collision chance, but retry)
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await prisma.inviteCode.findUnique({ where: { code } }).catch(() => null);
    if (!existing) break;
    code = generateCode();
  }
  const record = await prisma.inviteCode.create({
    data: { code, email: email || null },
  });
  return { id: record.id, code: record.code };
}

export async function validateInviteCode(code: string): Promise<{ valid: boolean; reason?: string; record?: any }> {
  if (!code || typeof code !== "string") {
    return { valid: false, reason: "invite code is required" };
  }
  const normalized = code.trim().toUpperCase();
  const record = await prisma.inviteCode.findUnique({ where: { code: normalized } });
  if (!record) return { valid: false, reason: "invalid invite code" };
  if (record.used) return { valid: false, reason: "invite code already used" };
  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    return { valid: false, reason: "invite code expired" };
  }
  return { valid: true, record };
}

export async function consumeInviteCode(code: string, usedBy: string): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  try {
    const updated = await prisma.inviteCode.updateMany({
      where: { code: normalized, used: false },
      data: { used: true, usedBy, usedAt: new Date() },
    });
    return updated.count > 0;
  } catch (err) {
    logger.error("[inviteCode] consume failed", { code: normalized, err });
    return false;
  }
}

export function isInviteRequired(): boolean {
  return loadConfig().inviteCodeRequired;
}

// Waitlist helpers

export async function joinWaitlist(email: string, walletAddress?: string): Promise<{ entry: any; position: number; total: number }> {
  const normalizedEmail = email.trim().toLowerCase();
  // idempotent: if already exists return existing position
  let entry = await prisma.waitlistEntry.findUnique({ where: { email: normalizedEmail } });
  if (entry) {
    const position = await getWaitlistPosition(normalizedEmail);
    const total = await prisma.waitlistEntry.count();
    return { entry, position, total };
  }
  entry = await prisma.waitlistEntry.create({
    data: { email: normalizedEmail, walletAddress: walletAddress || null, status: "pending" },
  });
  const position = await getWaitlistPosition(normalizedEmail);
  const total = await prisma.waitlistEntry.count();
  return { entry, position, total };
}

export async function getWaitlistPosition(email: string): Promise<number> {
  const normalizedEmail = email.trim().toLowerCase();
  const entry = await prisma.waitlistEntry.findUnique({ where: { email: normalizedEmail } });
  if (!entry) return -1;
  // position is rank ordered by createdAt asc
  const countBefore = await prisma.waitlistEntry.count({
    where: { createdAt: { lte: entry.createdAt } },
  });
  // But if we have exact timestamp collisions, need stable ordering; counting lte gives rank; however to be precise rank = number of entries with createdAt < entry.createdAt plus 1, plus tie-breaker by id? Simplify: count lte
  // Ensure position is 1-indexed
  return countBefore;
}

export async function promoteWaitlistBatch(limit: number): Promise<Array<{ email: string; code: string }>> {
  const pending = await prisma.waitlistEntry.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: Math.min(Math.max(limit, 1), 100),
  });

  const results: Array<{ email: string; code: string }> = [];
  for (const entry of pending) {
    const { code } = await createInviteCode(entry.email);
    await prisma.waitlistEntry.update({
      where: { id: entry.id },
      data: { status: "invited", inviteCode: code },
    });
    // email the code
    const sent = await sendGridSend({
      to: entry.email,
      subject: "Your RemitMortgage invite code is ready",
      html: `<p>Your invite code is <strong>${code}</strong>. Use it to complete registration. It can be used exactly once.</p>`,
    });
    if (!sent) {
      logger.warn("[waitlist] failed to email invite code", { email: entry.email, code });
    }
    results.push({ email: entry.email, code });
  }
  return results;
}
