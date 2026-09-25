// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import { verifySessionToken } from "../services/jwtKeyRing.js";
import { loadConfig } from "../config.js";

export interface AuthenticatedRequest extends Request {
  user?: {
    walletAddress: string;
    network: string;
  };
  workspaceAccess?: {
    workspaceId: string;
    role: string;
  };
}

export function authMiddleware(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  // Accept token from HTTP-only cookie or Authorization: Bearer <token> header
  const authHeader = req.headers.authorization;
  const token =
    req.cookies?.token ||
    (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);

  if (!token) {
    res.status(401).json({ error: "unauthorized", message: "Authentication token missing" });
    return;
  }

  try {
    const decoded = verifySessionToken(token) as {
      walletAddress: string;
      network: string;
    };
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
    return;
  }
}

/**
 * Gates admin-only routes (e.g. the audit log query endpoint) behind a static
 * API key, kept separate from the wallet-based JWT flow in {@link authMiddleware}.
 */
export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const { adminApiKey } = loadConfig();
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  // API-key callers remain supported for admin-only endpoints that do not
  // require a wallet identity.
  if (bearer && bearer === adminApiKey) {
    next();
    return;
  }

  const token = req.cookies?.token || bearer;

  if (!token) {
    res.status(401).json({ error: "missing_authorization", message: "Authorization header or admin session is required" });
    return;
  }

  try {
    const decoded = verifySessionToken(token) as {
      walletAddress: string;
      network: string;
    };

    req.user = decoded;

    const adminWallet = process.env.ADMIN_WALLET_ADDRESS?.toLowerCase();
    const wallet = decoded.walletAddress?.toLowerCase();

    if (!adminWallet || !wallet || wallet !== adminWallet) {
      res.status(403).json({ error: "forbidden", message: "Admin access required" });
      return;
    }

    next();
  } catch (err) {
    res.status(401).json({ error: "unauthorized", message: "Invalid or expired token" });
    return;
  }
}
