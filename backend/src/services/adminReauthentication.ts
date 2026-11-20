import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { authenticateAdmin2FA } from "./totpAuth.js";

export const ADMIN_REAUTH_WINDOW_MS = 5 * 60 * 1000;
const recentAuthentications = new Map<string, number>();

export function recordAdminReauthentication(adminAddress: string, code: string, now = Date.now()): boolean {
  const result = authenticateAdmin2FA(adminAddress, code);
  if (!result.authenticated) return false;
  recentAuthentications.set(adminAddress.toLowerCase(), now);
  return true;
}

export function hasRecentAdminReauthentication(adminAddress: string, now = Date.now()): boolean {
  const authenticatedAt = recentAuthentications.get(adminAddress.toLowerCase());
  return authenticatedAt !== undefined && now - authenticatedAt <= ADMIN_REAUTH_WINDOW_MS;
}

export function requireRecentAdminReauthentication(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  const address = req.user?.walletAddress;
  const code = req.header("x-admin-reauth-code");
  if (address && code && recordAdminReauthentication(address, code)) {
    next();
    return;
  }
  if (address && hasRecentAdminReauthentication(address)) {
    next();
    return;
  }
  res.status(401).json({
    error: "reauthentication_required",
    message: "This sensitive admin action requires fresh reauthentication. Reauthenticate and try again.",
  });
}
