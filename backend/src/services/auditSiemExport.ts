// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { prisma } from "./db.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";

export const SIEM_EXPORT_PAGE_SIZE = 500;
export const SIEM_MAX_WINDOW_DAYS = 90;

export interface SiemExportRequest {
  from: Date;
  to: Date;
  actions?: string[];
  actorAddress?: string;
  format?: "ndjson" | "cef";
  requestorAddress?: string;
}

export interface SiemExportResult {
  exportId: string;
  totalEvents: number;
  format: "ndjson" | "cef";
  chainHash: string; // HMAC-SHA256 over the full export payload for integrity verification
  pages: number;
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
 * HTTP/syslog.  The caller receives a final `chainHash` for end-to-end
 * integrity verification.
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
  const exportId = crypto.randomUUID();
  const allLines: string[] = [];
  let cursor: string | undefined;
  let pageIndex = 0;
  let totalEvents = 0;

  const where: Record<string, unknown> = {
    createdAt: { gte: req.from, lte: req.to },
  };
  if (req.actions && req.actions.length > 0) {
    where.action = { in: req.actions };
  }
  if (req.actorAddress) {
    where.actorAddress = req.actorAddress;
  }

  // Keyset pagination over (createdAt, id) to avoid OFFSET scans on large tables
  for (;;) {
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

    const lines =
      format === "cef"
        ? events.map(formatAsCef)
        : events.map(formatAsNdjson);

    allLines.push(...lines);
    totalEvents += rows.length;
    cursor = rows[rows.length - 1].id;

    try {
      await onPage(lines, pageIndex);
    } catch (err) {
      logger.error("[siemExport] onPage callback failed", {
        exportId,
        pageIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    pageIndex++;
    if (rows.length < SIEM_EXPORT_PAGE_SIZE) break;
  }

  const chainHash = buildExportChainHash(allLines, hmacSecret);

  logAudit({
    action: "audit.siem_export_completed",
    actorAddress: req.requestorAddress,
    metadata: {
      exportId,
      format,
      totalEvents,
      pages: pageIndex,
      from: req.from.toISOString(),
      to: req.to.toISOString(),
      actions: req.actions ?? null,
      actorFilter: req.actorAddress ?? null,
      chainHash,
    },
  });

  return { exportId, totalEvents, format, chainHash, pages: pageIndex };
}
