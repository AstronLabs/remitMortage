// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { requireAnyApiKey } from "../middleware/apiKeyAuth.js";
import {
  getApiKeyUsageReport,
  loadApiKeyQuotaConfig,
  quotaForPlan,
  readApiKeyUsage,
} from "../middleware/apiKeyQuota.js";
import logger from "../utils/logger.js";

export const apiKeyUsageRouter = Router();

/** Hard cap on the report's selected span (two years). */
const MAX_REPORT_WINDOW_DAYS = 730;

/**
 * Self-service usage read for the API key's own owner — authenticated by
 * presenting the key itself (any valid, non-revoked key; no specific scope
 * required), mirroring `GET /api/exports/transactions`'s auth but reading
 * consumption rather than data. This read is never itself metered.
 */
apiKeyUsageRouter.get("/usage", requireAnyApiKey(), async (_req, res) => {
  const apiKey = res.locals.apiKey as { id: string; plan: string; createdAt: Date };
  const config = loadApiKeyQuotaConfig();
  const quota = quotaForPlan(config, apiKey.plan);
  const { requestCount, periodStart, periodEnd } = await readApiKeyUsage(
    apiKey.id,
    apiKey.createdAt,
    config.periodDays
  );

  res.json({
    plan: apiKey.plan,
    quota,
    used: requestCount,
    remaining: Math.max(0, quota - requestCount),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  });
});

/** Parses an ISO query date; null means "present but unusable". */
function parseReportDate(raw: unknown): Date | null {
  if (typeof raw !== "string" || raw === "") return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * @openapi
 * /api/keys/usage/report:
 *   get:
 *     summary: Per-endpoint usage report for the authenticated API key
 *     description: >-
 *       Reports the key's own request totals and the breakdown by endpoint
 *       over a selectable period. Defaults to the current billing period;
 *       pass `since`/`until` (ISO) to cover a span of billing periods. The
 *       report is scoped strictly to the presented key and can never expose
 *       another key's usage. This read is not itself metered.
 *     tags:
 *       - API Keys
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Usage report for the authenticated key.
 *       400:
 *         description: Invalid or out-of-range period.
 */
apiKeyUsageRouter.get("/usage/report", requireAnyApiKey(), async (req, res) => {
  const apiKey = res.locals.apiKey as { id: string; plan: string; createdAt: Date };
  const config = loadApiKeyQuotaConfig();

  const hasSince = req.query.since !== undefined;
  const hasUntil = req.query.until !== undefined;
  const since = hasSince ? parseReportDate(req.query.since) : null;
  const until = hasUntil ? parseReportDate(req.query.until) : null;

  if ((hasSince && since === null) || (hasUntil && until === null)) {
    return res.status(400).json({ error: "invalid_period" });
  }
  if (since && until && since.getTime() > until.getTime()) {
    return res.status(400).json({ error: "invalid_period" });
  }
  if (since && until && until.getTime() - since.getTime() > MAX_REPORT_WINDOW_DAYS * 86_400_000) {
    return res.status(400).json({ error: "period_too_wide" });
  }

  try {
    const report = await getApiKeyUsageReport({
      apiKeyId: apiKey.id,
      keyCreatedAt: apiKey.createdAt,
      periodDays: config.periodDays,
      since: since ?? undefined,
      until: until ?? undefined,
    });
    return res.json(report);
  } catch (error) {
    logger.error("API key usage report error", { error });
    return res.status(500).json({ error: "usage_report_failed" });
  }
});
