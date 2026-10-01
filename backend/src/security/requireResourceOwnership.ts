// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { getApplication } from "../services/loanStore.js";

/** Wallet address configured as the operator/admin identity, if any. */
function adminWalletAddress(): string | null {
  const raw = process.env.ADMIN_WALLET_ADDRESS;
  return raw && raw.trim() ? raw.trim().toLowerCase() : null;
}

/** True when the caller is the configured admin wallet. */
export function isAdminRequest(req: AuthenticatedRequest): boolean {
  const wallet = req.user?.walletAddress?.toLowerCase();
  const admin = adminWalletAddress();
  return !!wallet && !!admin && wallet === admin;
}

/**
 * Ownership gate for borrower-scoped address params
 * (`/api/loan/borrower/:address`, `/api/borrower/:address/status`).
 * Returns true when the caller may proceed; sends 403 and returns false otherwise.
 */
export function requireBorrowerAddressOwnership(
  req: AuthenticatedRequest,
  res: Response,
  address: string
): boolean {
  const caller = req.user?.walletAddress;
  if (!caller) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return false;
  }
  if (caller.toLowerCase() === String(address).toLowerCase() || isAdminRequest(req)) {
    return true;
  }
  res.status(403).json({
    error: "forbidden",
    message: "You may only access your own borrower records.",
  });
  return false;
}

/**
 * Ownership gate for loan-ID params. Loads the loan, maps 404s, then enforces
 * borrower-ownership (or admin). Returns the loan when access is granted,
 * otherwise sends the error response and returns null.
 */
export async function requireLoanOwnership(
  req: AuthenticatedRequest,
  res: Response,
  loanId: string
): Promise<Awaited<ReturnType<typeof getApplication>> | null> {
  const caller = req.user?.walletAddress;
  if (!caller) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return null;
  }
  const app = await getApplication(loanId);
  if (!app) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (app.borrowerAddress.toLowerCase() === caller.toLowerCase() || isAdminRequest(req)) {
    return app;
  }
  res.status(403).json({
    error: "forbidden",
    message: "You may only access your own loan applications.",
  });
  return null;
}

/**
 * Operator-only gate for loan-ID params that must never be borrower-driven
 * (approve / reject / manual review). Borrowers — including the owning
 * borrower — receive 403; only the admin wallet may proceed.
 */
export async function requireLoanAdmin(
  req: AuthenticatedRequest,
  res: Response,
  loanId: string
): Promise<Awaited<ReturnType<typeof getApplication>> | null> {
  const app = await getApplication(loanId);
  if (!app) {
    res.status(404).json({ error: "not_found" });
    return null;
  }
  if (isAdminRequest(req)) return app;
  res.status(403).json({
    error: "forbidden",
    message: "Admin access required for this loan action.",
  });
  return null;
}

/** Express middleware variant of {@link requireBorrowerAddressOwnership}. */
export function borrowerOwnershipMiddleware(
  paramName = "address"
): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const raw = (req.params as Record<string, unknown>)?.[paramName];
    const address = Array.isArray(raw) ? String(raw[0]) : String(raw ?? "");
    if (requireBorrowerAddressOwnership(req, res, address)) next();
  };
}
