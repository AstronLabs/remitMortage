// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Interest rate sheet history admin surface (issue #746). Operator-only,
 * mounted under /api/admin:
 *   GET  /api/admin/rate-sheets                 — version history, newest first
 *   GET  /api/admin/rate-sheets/current         — version in effect now
 *   GET  /api/admin/rate-sheets/diff?from=&to=  — diff between two versions
 *   GET  /api/admin/rate-sheets/:versionId      — one version by number
 *   POST /api/admin/rate-sheets                 — publish a new version
 *   GET  /api/admin/loans/:id/rate-sheet        — version that priced a loan
 */

import { Router, Response } from "express";
import { requireAdmin, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  publishRateSheet,
  listRateSheetVersions,
  getRateSheetVersion,
  resolveRateSheetAt,
  diffRateSheetVersions,
  getRateSheetForLoan,
  RateSheetError,
} from "../services/rateSheet.js";
import logger from "../utils/logger.js";

export const rateSheetAdminRouter = Router();

function parseVersion(value: unknown): number | null {
  const n = Number(value);
  return typeof value === "string" && /^\d+$/.test(value) && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function handleError(err: unknown, res: Response, logMessage: string, fallbackCode: string) {
  if (err instanceof RateSheetError) {
    return res.status(err.httpStatus).json({ error: err.code, message: err.message });
  }
  logger.error(logMessage, { err });
  return res.status(500).json({ error: fallbackCode });
}

rateSheetAdminRouter.get("/rate-sheets", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const limit = req.query.limit === undefined ? 50 : parseVersion(req.query.limit);
  const before = req.query.before === undefined ? undefined : parseVersion(req.query.before);
  if (limit === null || before === null) {
    return res.status(400).json({ error: "invalid_field", message: "limit and before must be positive integers" });
  }
  try {
    const versions = await listRateSheetVersions(limit, before);
    return res.json({ versions });
  } catch (err) {
    return handleError(err, res, "Rate sheet list failed", "failed_to_list_rate_sheets");
  }
});

rateSheetAdminRouter.get("/rate-sheets/current", requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const version = await resolveRateSheetAt(new Date());
    if (!version) return res.status(404).json({ error: "not_found", message: "No rate sheet is in effect" });
    return res.json(version);
  } catch (err) {
    return handleError(err, res, "Current rate sheet lookup failed", "failed_to_load_rate_sheet");
  }
});

// Declared before /:versionId so "diff" is not read as a version number.
rateSheetAdminRouter.get("/rate-sheets/diff", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const to = parseVersion(req.query.to);
  // Default to comparing against the preceding version.
  const from = req.query.from === undefined && to !== null ? to - 1 : parseVersion(req.query.from);
  if (from === null || to === null || from < 1) {
    return res
      .status(400)
      .json({ error: "invalid_field", message: "to is required; from defaults to to-1 and both must be positive version numbers" });
  }
  try {
    return res.json(await diffRateSheetVersions(from, to));
  } catch (err) {
    return handleError(err, res, "Rate sheet diff failed", "failed_to_diff_rate_sheets");
  }
});

rateSheetAdminRouter.get("/rate-sheets/:versionId", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const version = parseVersion(req.params.versionId);
  if (version === null) {
    return res.status(400).json({ error: "invalid_field", message: "versionId must be a positive integer" });
  }
  try {
    const row = await getRateSheetVersion(version);
    if (!row) return res.status(404).json({ error: "not_found", message: "Rate sheet version not found" });
    return res.json(row);
  } catch (err) {
    return handleError(err, res, "Rate sheet lookup failed", "failed_to_load_rate_sheet");
  }
});

rateSheetAdminRouter.post("/rate-sheets", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const body = req.body ?? {};
  try {
    const created = await publishRateSheet({
      rates: body.rates,
      effectiveAt: body.effectiveAt,
      changeReason: body.changeReason,
      changedBy: req.user?.walletAddress ?? "admin-api-key",
      ipAddress: req.ip,
    });
    return res.status(201).json(created);
  } catch (err) {
    return handleError(err, res, "Rate sheet publish failed", "rate_sheet_publish_failed");
  }
});

rateSheetAdminRouter.get("/loans/:id/rate-sheet", requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const trace = await getRateSheetForLoan(String(req.params.id));
    if (!trace) return res.status(404).json({ error: "not_found", message: "Loan application not found" });
    return res.json(trace);
  } catch (err) {
    return handleError(err, res, "Loan rate sheet trace failed", "failed_to_load_loan_rate_sheet");
  }
});
