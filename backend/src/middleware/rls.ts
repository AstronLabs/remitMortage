// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { type Response, type NextFunction } from "express";
import { type AuthenticatedRequest } from "./auth.js";
import { prisma } from "../services/db.js";

/**
 * Row-Level Security middleware.
 *
 * Sets the PostgreSQL session variable `app.current_tenant` to the requesting
 * user's wallet address so that all subsequent queries in this connection are
 * automatically scoped to that tenant's rows.
 *
 * Admin requests (authenticated via the admin API key) bypass RLS by setting
 * `app.bypass_rls = true`, allowing cross-tenant reads when explicitly
 * elevated.
 */
export async function rlsMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const walletAddress = req.user?.walletAddress;

    if (!walletAddress) {
      // Unauthenticated requests proceed without tenant context;
      // RLS policies will filter out everything (deny-by-default).
      return next();
    }

    // Detect admin bypass: the presence of a valid admin API key means
    // the operator has explicitly elevated past tenant isolation.
    const isAdminRequest = isAdminAuth(req);

    // Use raw SQL to set the session variable on the connection Prisma
    // will use for this request's transaction scope.
    const rawPrisma = prisma as any;
    if (typeof rawPrisma.$executeRawUnsafe === "function") {
      if (isAdminRequest) {
        await rawPrisma.$executeRawUnsafe("SELECT set_tenant_bypass(true)");
      }
      await rawPrisma.$executeRawUnsafe(
        "SELECT set_current_tenant($1)",
        walletAddress,
      );
    }

    next();
  } catch (error) {
    // Never let RLS setup failures crash the request pipeline.
    // Log and continue — the database will still enforce RLS at the
    // policy level regardless of this middleware.
    console.error("[rls-middleware] Failed to set tenant context:", error);
    next();
  }
}

/**
 * Returns true when the request carries a valid admin API key in the
 * Authorization header, indicating an explicitly elevated operator session.
 */
function isAdminAuth(req: AuthenticatedRequest): boolean {
  const authHeader = req.headers.authorization;
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const adminApiKey = process.env.ADMIN_API_KEY;
  return !!adminApiKey && !!bearer && bearer === adminApiKey;
}
