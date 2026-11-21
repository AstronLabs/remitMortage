// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";

export interface UserSession {
  sessionId: string;
  walletAddress: string;
  createdAt: string;
  lastUsedAt: string;
  coarseLocation: string;
  deviceSummary: string;
  /**
   * SHA-256 of the device fingerprint presented at login (issue #992). Only
   * the hash is stored, so a leaked session record cannot be replayed as a
   * device identifier.
   */
  deviceFingerprint?: string;
  revokedAt?: string;
}

export interface CreateSessionInput {
  sessionId?: string;
  walletAddress: string;
  userAgent?: string;
  coarseLocation?: string;
  deviceFingerprint?: string;
  now?: Date;
}

const sessions = new Map<string, UserSession>();

export function summarizeDevice(userAgent?: string): string {
  if (!userAgent || userAgent.trim() === "") return "Unknown device";
  const ua = userAgent;
  const browser =
    /Edg\//i.test(ua)
      ? "Edge"
      : /Chrome\//i.test(ua)
        ? "Chrome"
        : /Firefox\//i.test(ua)
          ? "Firefox"
          : /Safari\//i.test(ua)
            ? "Safari"
            : "Client";
  const os =
    /iPhone|iPad|iOS/i.test(ua)
      ? "iOS"
      : /Android/i.test(ua)
        ? "Android"
        : /Mac OS X|Macintosh/i.test(ua)
          ? "macOS"
          : /Windows/i.test(ua)
            ? "Windows"
            : /Linux/i.test(ua)
              ? "Linux"
              : "Unknown OS";
  return `${browser} on ${os}`;
}

export function createUserSession(input: CreateSessionInput): UserSession {
  const nowIso = (input.now ?? new Date()).toISOString();
  const session: UserSession = {
    sessionId: input.sessionId ?? crypto.randomUUID(),
    walletAddress: input.walletAddress,
    createdAt: nowIso,
    lastUsedAt: nowIso,
    coarseLocation: input.coarseLocation?.trim() || "Unknown",
    deviceSummary: summarizeDevice(input.userAgent),
    deviceFingerprint: input.deviceFingerprint,
  };
  sessions.set(session.sessionId, session);
  return { ...session };
}

/**
 * True when this wallet has previously signed in from the given hashed
 * fingerprint (issue #992). Revoked sessions still count — revoking a session
 * is not the same as distrusting a device.
 */
export function isKnownDevice(walletAddress: string, deviceFingerprint: string | undefined): boolean {
  if (!deviceFingerprint) return false;
  const owner = walletAddress.toLowerCase();
  for (const s of sessions.values()) {
    if (s.walletAddress.toLowerCase() === owner && s.deviceFingerprint === deviceFingerprint) {
      return true;
    }
  }
  return false;
}

export function isSessionRevoked(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  return Boolean(s && s.revokedAt);
}

export function isSessionActive(sessionId: string): boolean {
  const s = sessions.get(sessionId);
  if (!s) return true; // Untracked legacy token without a stored session record.
  return !s.revokedAt;
}

export function touchSession(sessionId: string, now: Date = new Date()): void {
  const s = sessions.get(sessionId);
  if (s && !s.revokedAt) {
    s.lastUsedAt = now.toISOString();
  }
}

export function listActiveSessions(
  walletAddress: string,
  currentSessionId?: string
): Array<UserSession & { current: boolean }> {
  const owner = walletAddress.toLowerCase();
  const out: Array<UserSession & { current: boolean }> = [];
  for (const s of sessions.values()) {
    if (s.walletAddress.toLowerCase() === owner && !s.revokedAt) {
      out.push({ ...s, current: Boolean(currentSessionId && s.sessionId === currentSessionId) });
    }
  }
  return out;
}

export type RevokeSessionResult =
  | { ok: true; session: UserSession }
  | { ok: false; reason: "not_found" | "forbidden" };

export function revokeSession(
  walletAddress: string,
  sessionId: string,
  now: Date = new Date()
): RevokeSessionResult {
  const s = sessions.get(sessionId);
  if (!s || s.revokedAt) {
    return { ok: false, reason: "not_found" };
  }
  if (s.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    return { ok: false, reason: "forbidden" };
  }
  s.revokedAt = now.toISOString();
  return { ok: true, session: { ...s } };
}

export function revokeOtherSessions(
  walletAddress: string,
  currentSessionId: string | undefined,
  now: Date = new Date()
): { revokedCount: number; revokedSessionIds: string[] } {
  const owner = walletAddress.toLowerCase();
  const revokedSessionIds: string[] = [];
  const nowIso = now.toISOString();
  for (const s of sessions.values()) {
    if (
      s.walletAddress.toLowerCase() === owner &&
      !s.revokedAt &&
      s.sessionId !== currentSessionId
    ) {
      s.revokedAt = nowIso;
      revokedSessionIds.push(s.sessionId);
    }
  }
  return { revokedCount: revokedSessionIds.length, revokedSessionIds };
}

export function clearUserSessions(): void {
  sessions.clear();
}
