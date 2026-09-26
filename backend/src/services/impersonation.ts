import jwt from "jsonwebtoken";
import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

/** Read-only support sessions expire quickly — long enough to troubleshoot, short enough to bound exposure. */
export const IMPERSONATION_SESSION_TTL_MS = 15 * 60 * 1000;

export const IMPERSONATION_COOKIE = "impersonation_token";

export interface ImpersonationClaims {
  walletAddress: string;
  network: string;
  impersonation: {
    sessionId: string;
    adminAddress: string;
    readOnly: true;
  };
}

export interface ImpersonationStatus {
  active: boolean;
  sessionId: string | null;
  adminAddress: string | null;
  targetAddress: string | null;
  startedAt: string | null;
  expiresAt: string | null;
}

/**
 * Starts a scoped, time-limited, read-only "view as user" session for support
 * troubleshooting. Returns a signed JWT (to be set as a separate cookie from
 * the admin's own session token, so the admin's identity is never clobbered
 * and `requireAdmin` keeps working for ending the session) plus the session
 * record used to enforce and audit it.
 */
export async function startImpersonation(params: {
  adminAddress: string;
  targetAddress: string;
  ipAddress?: string;
  reason?: string;
}): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const { adminAddress, targetAddress, ipAddress, reason } = params;

  if (adminAddress.toLowerCase() === targetAddress.toLowerCase()) {
    throw new Error("An admin cannot impersonate their own wallet");
  }

  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + IMPERSONATION_SESSION_TTL_MS);

  const session = await prisma.impersonationSession.create({
    data: {
      adminAddress,
      targetAddress,
      ipAddress,
      reason,
      startedAt,
      expiresAt,
    },
  });

  const claims: ImpersonationClaims = {
    walletAddress: targetAddress,
    network: loadConfig().stellarNetwork,
    impersonation: {
      sessionId: session.id,
      adminAddress,
      readOnly: true,
    },
  };

  const token = jwt.sign(claims, process.env.JWT_SECRET || "default_jwt_secret", {
    expiresIn: Math.floor(IMPERSONATION_SESSION_TTL_MS / 1000),
  });

  await logAudit({
    action: "admin_impersonation_started",
    actorAddress: adminAddress,
    ipAddress,
    metadata: {
      sessionId: session.id,
      targetAddress,
      reason: reason ?? null,
      startedAt: startedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    },
  });

  return { token, sessionId: session.id, expiresAt };
}

/**
 * Ends an impersonation session (either the admin explicitly signing out of
 * it, or expiry cleanup) and writes the matching audit entry. Duration is
 * computed here rather than left to whoever reads the audit trail later.
 */
export async function endImpersonation(params: {
  sessionId: string;
  endedBy: string;
}): Promise<void> {
  const { sessionId, endedBy } = params;

  const session = await prisma.impersonationSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  if (session.endedAt) return; // already ended — avoid duplicate audit entries

  const endedAt = new Date();
  await prisma.impersonationSession.update({
    where: { id: sessionId },
    data: { endedAt, endedBy },
  });

  await logAudit({
    action: "admin_impersonation_ended",
    actorAddress: session.adminAddress,
    metadata: {
      sessionId: session.id,
      targetAddress: session.targetAddress,
      endedBy,
      startedAt: session.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: endedAt.getTime() - session.startedAt.getTime(),
    },
  });
}

/**
 * Confirms an impersonation session referenced by a request's JWT is still
 * valid — i.e. hasn't been explicitly ended early or (defensively) outlived
 * its expiry despite a still-unexpired JWT signature. Only called for the
 * (rare) request that actually carries an impersonation cookie, so this
 * doesn't add a DB round-trip to the common request path.
 */
export async function isImpersonationSessionActive(sessionId: string): Promise<boolean> {
  try {
    const session = await prisma.impersonationSession.findUnique({ where: { id: sessionId } });
    if (!session) return false;
    if (session.endedAt) return false;
    if (session.expiresAt.getTime() <= Date.now()) return false;
    return true;
  } catch (error) {
    logger.error("[impersonation] session validity check failed", { error, sessionId });
    return false;
  }
}

export async function getImpersonationStatus(sessionId: string | null): Promise<ImpersonationStatus> {
  if (!sessionId) {
    return { active: false, sessionId: null, adminAddress: null, targetAddress: null, startedAt: null, expiresAt: null };
  }

  const session = await prisma.impersonationSession.findUnique({ where: { id: sessionId } });
  if (!session || session.endedAt || session.expiresAt.getTime() <= Date.now()) {
    return { active: false, sessionId: null, adminAddress: null, targetAddress: null, startedAt: null, expiresAt: null };
  }

  return {
    active: true,
    sessionId: session.id,
    adminAddress: session.adminAddress,
    targetAddress: session.targetAddress,
    startedAt: session.startedAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  };
}
