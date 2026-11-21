// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { requireAdmin, authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";
import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";
import { exportAuditLogToSiem, SIEM_MAX_WINDOW_DAYS } from "../services/auditSiemExport.js";
import { verifyAuditRange } from "../services/auditChain.js";
import { EXPORT_REDACTION_LEVELS, resolveExportRedactionLevel } from "../services/exportRedaction.js";

export const auditRouter = Router();

/** Query durations above this are logged so slow-query regressions surface under load. */
const SLOW_QUERY_THRESHOLD_MS = 50;

/**
 * @openapi
 * /api/audit-logs:
 *   get:
 *     summary: Query historical transaction logs
 *     description: >-
 *       Returns keyset (cursor) paginated audit logs, filterable by event type
 *       and actor. Cursor pagination is used instead of OFFSET/COUNT so deep
 *       pages over large event tables stay fast and don't hold read locks
 *       during concurrent write spikes. Admin access only.
 *     tags:
 *       - Audit
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: cursor
 *         schema:
 *           type: string
 *         description: Id of the last record from the previous page. Omit for the first page.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *         description: Number of records per page
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *         description: Filter by action name (event type)
 *       - in: query
 *         name: actorAddress
 *         schema:
 *           type: string
 *         description: Filter by actor wallet address
 *     responses:
 *       200:
 *         description: A cursor-paginated list of audit logs
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       500:
 *         description: Server error
 */
auditRouter.get("/", requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit as string) || 20));
    const cursor = typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : undefined;

    const action = req.query.action as string | undefined;
    const actorAddress = req.query.actorAddress as string | undefined;

    const where: any = {};
    if (action) where.action = action;
    if (actorAddress) where.actorAddress = actorAddress;

    const startedAt = process.hrtime.bigint();

    // Keyset (cursor) pagination on the (action, createdAt) index: no OFFSET
    // scan and no COUNT(*) over the full result set, which is what caused CPU
    // spikes/lock contention on large transaction histories. One extra row is
    // fetched to cheaply detect whether a next page exists.
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(cursor ? ({ cursor: ({ id: cursor } as any), skip: 1 } as any) : {}),
    });

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn("Audit log query exceeded latency budget", {
        durationMs,
        limit,
        action,
        actorAddress,
        cursor,
      });
    }

    const hasNextPage = rows.length > limit;
    const data = hasNextPage ? rows.slice(0, limit) : rows;
    const nextCursor = hasNextPage ? data[data.length - 1].id : null;

    return res.json({
      data,
      pagination: {
        limit,
        cursor: cursor ?? null,
        nextCursor,
        hasNextPage,
      },
    });
  } catch (error) {
    console.error("Audit query error:", error);
    return res.status(500).json({ error: "Failed to query audit logs" });
  }
});

/**
 * GET /api/audit-logs/verify
 *
 * Recomputes the tamper-evident hash chain (issue #861) over an optional
 * time range and reports whether the entries link up and match their stored
 * hashes. Returns 409 when the chain is broken so a monitoring check can alert
 * on it. Admin-only.
 */
auditRouter.get("/verify", requireAdmin, async (req, res) => {
  try {
    const parse = (value: unknown): Date | undefined => {
      if (typeof value !== "string" || !value) return undefined;
      const date = new Date(value);
      return isNaN(date.getTime()) ? undefined : date;
    };
    const from = parse(req.query.from);
    const to = parse(req.query.to);

    const result = await verifyAuditRange({ from, to });
    return res.status(result.ok ? 200 : 409).json({
      ok: result.ok,
      verified: result.verified,
      head: result.head,
      ...(result.brokenAt ? { brokenAt: result.brokenAt } : {}),
    });
  } catch (error) {
    logger.error("Audit chain verification failed", { error });
    return res.status(500).json({ error: "Failed to verify audit chain" });
  }
});

/**
 * POST /api/audit-logs/siem-export
 *
 * Streams a time-windowed audit export suitable for ingestion by an external
 * SIEM (Splunk, Elastic, Datadog, etc.).  The response is streamed as NDJSON
 * or CEF lines; a trailing `X-Export-Chain-Hash` header carries the HMAC-SHA256
 * integrity fingerprint so the consumer can verify the payload end-to-end.
 *
 * Admin-only.  Maximum window: 90 days.
 *
 * `redactionLevel` (issue #1104) picks how much PII the export carries for its
 * audience: `full`, `partial` (masked actor, truncated IP, PII metadata keys
 * redacted) or `aggregate` (per-action counts only). Defaults to the most
 * redacted, `aggregate`; the level used is recorded in the export audit entry.
 */
auditRouter.post(
  "/siem-export",
  authMiddleware,
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    const { from, to, actions, actorAddress, format, redactionLevel } = req.body as {
      from?: string;
      to?: string;
      actions?: string[];
      actorAddress?: string;
      format?: "ndjson" | "cef";
      redactionLevel?: unknown;
    };

    const resolvedRedactionLevel = resolveExportRedactionLevel(redactionLevel);
    if (!resolvedRedactionLevel) {
      return res.status(400).json({
        error: `'redactionLevel' must be one of: ${EXPORT_REDACTION_LEVELS.join(", ")}`,
      });
    }

    if (!from || !to) {
      return res.status(400).json({ error: "'from' and 'to' are required" });
    }

    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format" });
    }

    const windowDays =
      (toDate.getTime() - fromDate.getTime()) / (1_000 * 60 * 60 * 24);
    if (windowDays <= 0) {
      return res.status(400).json({ error: "'to' must be after 'from'" });
    }
    if (windowDays > SIEM_MAX_WINDOW_DAYS) {
      return res
        .status(400)
        .json({ error: `Export window cannot exceed ${SIEM_MAX_WINDOW_DAYS} days` });
    }

    const resolvedFormat: "ndjson" | "cef" =
      format === "cef" ? "cef" : "ndjson";

    const contentType =
      resolvedFormat === "cef" ? "text/plain" : "application/x-ndjson";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-siem-export.${resolvedFormat === "cef" ? "cef" : "ndjson"}"`
    );
    res.setHeader("Transfer-Encoding", "chunked");
    res.setHeader("X-Export-Format", resolvedFormat);
    res.setHeader("X-Export-Redaction-Level", resolvedRedactionLevel);

    let clientDisconnected = false;
    const markDisconnected = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    };
    req.on("close", markDisconnected);
    res.on("close", markDisconnected);

    const hmacSecret =
      process.env.SIEM_EXPORT_HMAC_SECRET ?? "default_siem_secret";

    try {
      const result = await exportAuditLogToSiem(
        {
          from: fromDate,
          to: toDate,
          actions: Array.isArray(actions) ? actions : undefined,
          actorAddress: actorAddress ?? undefined,
          format: resolvedFormat,
          requestorAddress: req.user?.walletAddress,
          redactionLevel: resolvedRedactionLevel,
          shouldAbort: () => clientDisconnected || res.destroyed || res.writableEnded,
        },
        hmacSecret,
        async (lines) => {
          for (const line of lines) {
            if (clientDisconnected || res.destroyed || res.writableEnded) break;
            res.write(line + "\n");
          }
        }
      );

      res.setHeader("X-Export-Id", result.exportId);
      res.setHeader("X-Export-Total-Events", String(result.totalEvents));
      res.setHeader("X-Export-Chain-Hash", result.chainHash);
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        return res.status(500).json({ error: "Export failed" });
      }
      res.end();
    }
  }
);
