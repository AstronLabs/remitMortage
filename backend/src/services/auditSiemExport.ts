// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";
import {
  DEFAULT_EXPORT_REDACTION_LEVEL,
  maskIdentifier,
  redactMetadata,
  truncateIp,
  type ExportRedactionLevel,
} from "./exportRedaction.js";

export const SIEM_EXPORT_PAGE_SIZE = 500;
export const SIEM_MAX_WINDOW_DAYS = 90;

export interface SiemExportRequest {
  from: Date;
  to: Date;
  actions?: string[];
  actorAddress?: string;
  format?: "ndjson" | "cef";
  requestorAddress?: string;
  /** PII redaction level (issue #1104). Defaults to the most redacted, `aggregate`. */
  redactionLevel?: ExportRedactionLevel;
  /** Optional predicate checked between batches so a client disconnect stops the query early (#994). */
  shouldAbort?: () => boolean;
}

export interface SiemExportResult {
  exportId: string;
  totalEvents: number;
  format: "ndjson" | "cef";
  chainHash: string; // HMAC-SHA256 over the full export payload for integrity verification
  pages: number;
  redactionLevel: ExportRedactionLevel;
  aborted?: boolean;
}

/** One row of an `aggregate` export: counts only, no actor, IP or metadata. */
export interface AggregateExportRow {
  action: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface AuditExportEvent {
  id: string;
  action: string;
  actorAddress: string | null;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: string; // ISO 8601
}

// ── Format helpers ────────────────────────────────────────────────────────────

/**
 * Formats a single audit event as CEF (Common Event Format) for SIEM ingestion.
 * CEF spec: CEF:Version|DeviceVendor|DeviceProduct|DeviceVersion|DeviceEventClassID|Name|Severity|Extension
 */
export function formatAsCef(event: AuditExportEvent): string {
  const ext = [
    `rt=${new Date(event.createdAt).getTime()}`,
    event.actorAddress ? `suser=${event.actorAddress.replace(/[|\\=]/g, "_")}` : null,
    event.ipAddress ? `src=${event.ipAddress}` : null,
    `msg=${JSON.stringify(event.metadata ?? {}).replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`,
  ]
    .filter(Boolean)
    .join(" ");

  const name = event.action.replace(/[|\\=]/g, "_");
  return `CEF:0|RemitMortgage|AuditLog|1.0|${event.id}|${name}|5|${ext}`;
}

/**
 * Returns an NDJSON line for one event (the SIEM can parse it as structured JSON).
 */
export function formatAsNdjson(event: AuditExportEvent): string {
  return JSON.stringify(event);
}

/** Applies `partial` redaction to one event; `full` events pass through unchanged. */
export function redactEvent(event: AuditExportEvent, level: "full" | "partial"): AuditExportEvent {
  if (level === "full") return event;
  return {
    ...event,
    actorAddress: maskIdentifier(event.actorAddress),
    ipAddress: truncateIp(event.ipAddress),
    metadata: redactMetadata(event.metadata),
  };
}

export function formatAggregateAsCef(row: AggregateExportRow): string {
  const name = row.action.replace(/[|\\=]/g, "_");
  return `CEF:0|RemitMortgage|AuditLog|1.0|aggregate|${name}|1|cnt=${row.count} start=${new Date(row.firstSeen).getTime()} end=${new Date(row.lastSeen).getTime()}`;
}

// ── Hash-chain integrity ──────────────────────────────────────────────────────

/**
 * Builds a rolling HMAC-SHA256 over each serialised line in order.
 * The consumer can reproduce this chain from the same secret to verify the
 * export has not been tampered with in transit or at rest.
 */
export function buildExportChainHash(lines: string[], secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  for (const line of lines) {
    hmac.update(line + "\n");
  }
  return hmac.digest("hex");
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Streams historical audit log entries to the caller in pages.
 * Each page is an array of formatted lines ready to forward to a SIEM over
 * HTTP/syslog. The rolling HMAC-SHA256 is updated incrementally per page so
 * peak memory never grows with the total number of exported events (#994).
 */
export async function exportAuditLogToSiem(
  req: SiemExportRequest,
  hmacSecret: string,
  onPage: (lines: string[], pageIndex: number) => Promise<void>
): Promise<SiemExportResult> {
  const windowDays =
    (req.to.getTime() - req.from.getTime()) / (1_000 * 60 * 60 * 24);

  if (windowDays <= 0) {
    throw new Error("'to' must be after 'from'");
  }
  if (windowDays > SIEM_MAX_WINDOW_DAYS) {
    throw new Error(
      `Export window cannot exceed ${SIEM_MAX_WINDOW_DAYS} days`
    );
  }

  const format = req.format ?? "ndjson";
  const redactionLevel = req.redactionLevel ?? DEFAULT_EXPORT_REDACTION_LEVEL;
  const aggregates = new Map<string, AggregateExportRow>();
  const exportId = crypto.randomUUID();
  const rollingHmac = crypto.createHmac("sha256", hmacSecret);
  let cursor: string | undefined;
  let pageIndex = 0;
  let totalEvents = 0;
  let aborted = false;

  const where: Record<string, unknown> = {
    createdAt: { gte: req.from, lte: req.to },
  };
  if (req.actions && req.actions.length > 0) {
    where.action = { in: req.actions };
  }
  if (req.actorAddress) {
    where.actorAddress = req.actorAddress;
  }

  async function emitPage(lines: string[], index: number): Promise<void> {
    for (const line of lines) {
      rollingHmac.update(line + "\n");
    }
    try {
      await onPage(lines, index);
    } catch (err) {
      logger.error("[siemExport] onPage callback failed", {
        exportId,
        pageIndex: index,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Keyset pagination over (createdAt, id) to avoid OFFSET scans on large tables
  for (;;) {
    if (req.shouldAbort?.()) {
      aborted = true;
      break;
    }

    const rows = await prisma.auditLog.findMany({
      where: cursor
        ? { ...where, id: { gt: cursor } }
        : where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: SIEM_EXPORT_PAGE_SIZE,
      select: {
        id: true,
        action: true,
        actorAddress: true,
        ipAddress: true,
        metadata: true,
        createdAt: true,
      },
    });

    if (rows.length === 0) break;

    const events: AuditExportEvent[] = rows.map((r: any) => ({
      id: r.id,
      action: r.action,
      actorAddress: r.actorAddress ?? null,
      ipAddress: r.ipAddress ?? null,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    }));

    totalEvents += rows.length;
    cursor = rows[rows.length - 1].id;

    if (redactionLevel === "aggregate") {
      // No per-event rows leave the server; only counts, emitted once below.
      for (const e of events) {
        const row = aggregates.get(e.action);
        if (row) {
          row.count++;
          if (e.createdAt < row.firstSeen) row.firstSeen = e.createdAt;
          if (e.createdAt > row.lastSeen) row.lastSeen = e.createdAt;
        } else {
          aggregates.set(e.action, { action: e.action, count: 1, firstSeen: e.createdAt, lastSeen: e.createdAt });
        }
      }
    } else {
      const redacted = events.map((e) => redactEvent(e, redactionLevel));
      const lines =
        format === "cef"
          ? redacted.map(formatAsCef)
          : redacted.map(formatAsNdjson);

      await emitPage(lines, pageIndex);
      pageIndex++;
    }

    if (req.shouldAbort?.()) {
      aborted = true;
      break;
    }

    if (rows.length < SIEM_EXPORT_PAGE_SIZE) break;
  }

  if (!aborted && redactionLevel === "aggregate" && aggregates.size > 0) {
    const rowsOut = [...aggregates.values()].sort((a, b) => a.action.localeCompare(b.action));
    const lines =
      format === "cef"
        ? rowsOut.map(formatAggregateAsCef)
        : rowsOut.map((r) => JSON.stringify(r));
    await emitPage(lines, pageIndex);
    pageIndex++;
  }

  const chainHash = rollingHmac.digest("hex");

  logAudit({
    action: "audit.siem_export_completed",
    actorAddress: req.requestorAddress,
    metadata: {
      exportId,
      format,
      redactionLevel,
      totalEvents,
      pages: pageIndex,
      from: req.from.toISOString(),
      to: req.to.toISOString(),
      actions: req.actions ?? null,
      actorFilter: req.actorAddress ?? null,
      chainHash,
      ...(aborted ? { aborted: true } : {}),
    },
  });

  return {
    exportId,
    totalEvents,
    format,
    chainHash,
    pages: pageIndex,
    redactionLevel,
    ...(aborted ? { aborted: true } : {}),
  };
}
