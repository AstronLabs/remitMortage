// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Scheduled unused-index report (issue #758).
 *
 * Reads Postgres index-usage statistics (`pg_stat_user_indexes`), joins
 * constraint metadata (`pg_constraint` via `pg_index.indisunique` /
 * `indisprimary`) and sizes (`pg_relation_size`), then flags indexes with
 * zero/negligible scans over a sustained observation window as removal
 * candidates — with table, columns, size, and last-used context for a human
 * reviewer.
 *
 * Hard guarantees:
 * - Constraint-backing indexes (primary key / unique) are NEVER flagged,
 *   regardless of scan activity.
 * - This job NEVER drops an index. It only reports. Removal follows the
 *   human review process in `docs/UNUSED_INDEX_REVIEW.md`.
 *
 * Sustained-observation tracking: consecutive-run scan totals are persisted
 * to a small JSON snapshot file (`UNUSED_INDEX_SNAPSHOT_PATH`, default
 * `<cwd>/storage/unused-index-snapshot.json`) so "sustained near-zero usage"
 * means idle across at least two scheduled runs, surviving restarts and
 * `pg_stat` resets (a stats reset is treated as a fresh observation, never
 * as evidence of use).
 */

import { promises as fs } from "fs";
import path from "path";
import { prisma } from "../services/db.js";
import { getBrandedHtml, sendEmail } from "../services/email.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import {
  buildUnusedIndexReport,
  findUnusedIndexCandidates,
  formatBytes,
  type IndexUsageStat,
  type UnusedIndexReport,
} from "../services/unusedIndexAudit.js";

export const UNUSED_INDEX_MIN_OBSERVATION_DAYS = Number(
  process.env.UNUSED_INDEX_MIN_OBSERVATION_DAYS ?? 14
);
export const UNUSED_INDEX_MAX_SCANS = Number(process.env.UNUSED_INDEX_MAX_SCANS ?? 0);

interface RawIndexRow {
  schemaname: string;
  tablename: string;
  indexname: string;
  idx_scan: string | number | bigint;
  idx_tup_read: string | number | bigint;
  indexrelid: string | number;
  indisunique: boolean;
  indisprimary: boolean;
  constraintkind: string | null;
  size_bytes: string | number | bigint;
  indexdef: string | null;
  columns: string | null;
}

const toNum = (v: string | number | bigint | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Reads live index-usage statistics from Postgres. Split out for testing —
 * pass a custom `query` in unit tests instead of touching the database.
 */
export async function fetchIndexUsageStats(
  query: () => Promise<RawIndexRow[]> = defaultQuery
): Promise<IndexUsageStat[]> {
  const rows = await query();
  return rows.map((row) => {
    const scans = toNum(row.idx_scan);
    return {
      table: `${row.schemaname}.${row.tablename}`,
      indexName: row.indexname,
      columns: String(row.columns ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean),
      scans,
      tuplesRead: toNum(row.idx_tup_read),
      sizeBytes: toNum(row.size_bytes),
      // pg_stat_user_indexes carries no last-used timestamp; sustained
      // idleness across consecutive snapshots is the usage signal (see the
      // snapshot logic below). Reported as null so reviewers do not mistake
      // the snapshot date for a last-scan timestamp.
      lastUsedAt: null,
      observedForDays: UNUSED_INDEX_MIN_OBSERVATION_DAYS,
      isConstraintBacked: row.indisprimary === true || row.indisunique === true,
      constraintKind: row.indisprimary
        ? "PRIMARY KEY"
        : row.indisunique
          ? (row.constraintkind ?? "UNIQUE")
          : undefined,
      definition: row.indexdef ?? undefined,
    };
  });
}

async function defaultQuery(): Promise<RawIndexRow[]> {
  return (await prisma.$queryRaw<RawIndexRow[]>`
    SELECT
      s.schemaname,
      s.tablename,
      s.indexrelname AS indexname,
      s.idx_scan,
      s.idx_tup_read,
      s.indexrelid,
      i.indisunique,
      i.indisprimary,
      c.contype AS constraintkind,
      pg_relation_size(s.indexrelid) AS size_bytes,
      pg_get_indexdef(s.indexrelid) AS indexdef,
      (
        SELECT string_agg(a.attname, ', ' ORDER BY k.ord)
        FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a
          ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      ) AS columns
    FROM pg_stat_user_indexes s
    JOIN pg_index i ON i.indexrelid = s.indexrelid
    LEFT JOIN pg_constraint c ON c.conindid = s.indexrelid
    WHERE s.schemaname NOT IN ('pg_catalog', 'information_schema')
  `) as RawIndexRow[];
}

export function snapshotPath(): string {
  return (
    process.env.UNUSED_INDEX_SNAPSHOT_PATH ??
    path.join(process.cwd(), "storage", "unused-index-snapshot.json")
  );
}

export interface IndexSnapshot {
  /** ISO timestamp of the run that wrote the snapshot. */
  takenAt: string;
  /** Scan totals by index name. */
  scans: Record<string, number>;
}

export async function loadSnapshot(file = snapshotPath()): Promise<IndexSnapshot | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as IndexSnapshot;
    if (!parsed || typeof parsed.scans !== "object") return null;
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn("[unused-index-audit] Could not read prior snapshot; treating as first observation", {
      err,
    });
    return null;
  }
}

export async function saveSnapshot(snapshot: IndexSnapshot, file = snapshotPath()): Promise<void> {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (err) {
    logger.warn("[unused-index-audit] Non-fatal: failed to persist snapshot", { err });
  }
}

export function buildReportHtml(report: UnusedIndexReport): string {
  const rows =
    report.candidates
      .map(
        (c) => `
      <tr>
        <td class="details-value"><code>${c.indexName}</code></td>
        <td class="details-value"><code>${c.table}</code> (${c.columns.join(", ") || "—"})</td>
        <td class="details-value">${formatBytes(c.sizeBytes)}</td>
        <td class="details-value">${c.scans} scans / ${c.consecutiveIdleObservations} idle obs.</td>
        <td class="details-value">${c.reason}</td>
      </tr>`
      )
      .join("\n") ||
    `<tr><td colspan="5" class="details-value">No unused-index candidates this run.</td></tr>`;

  return getBrandedHtml(
    "RemitMortgage — Unused Index Report",
    `
    <h2>Unused Index Candidates</h2>
    <p><strong>${report.candidates.length}</strong> candidate(s) across
    <strong>${report.indexesScanned}</strong> scanned indexes
    (${report.observationDays}d observation window).
    Estimated reclaimable: <strong>${formatBytes(report.totalReclaimableBytes)}</strong>.</p>
    <table class="details-table">
      <tr>
        <td class="details-label"><strong>Index</strong></td>
        <td class="details-label"><strong>Table (columns)</strong></td>
        <td class="details-label"><strong>Size</strong></td>
        <td class="details-label"><strong>Usage</strong></td>
        <td class="details-label"><strong>Reason</strong></td>
      </tr>
      ${rows}
    </table>
    <p style="margin-top:16px;font-size:13px;color:#64748b;">
      Constraint-backed indexes excluded from candidates:
      ${report.excludedConstraintIndexes.length ? report.excludedConstraintIndexes.map((n) => `<code>${n}</code>`).join(", ") : "none"}.
      This report never drops anything — follow <code>docs/UNUSED_INDEX_REVIEW.md</code> for the human review/removal process.
    </p>`
  );
}

export interface UnusedIndexAuditResult {
  report: UnusedIndexReport;
  emailed: number;
}

export async function runUnusedIndexAuditJob(
  overrides: {
    fetchStats?: () => Promise<IndexUsageStat[]>;
    recipients?: string[];
    snapshotFile?: string;
  } = {}
): Promise<UnusedIndexAuditResult> {
  const stats = overrides.fetchStats ? await overrides.fetchStats() : await fetchIndexUsageStats();
  const previous = await loadSnapshot(overrides.snapshotFile ?? snapshotPath());

  // A pg_stat reset (server restart, manual reset) zeroes every counter. A
  // counter that went *backwards* since the last snapshot proves a reset, so
  // that index is treated as freshly observed — never as sustained-idle.
  const previousScans: Record<string, number> | undefined = previous
    ? Object.fromEntries(
        Object.entries(previous.scans).filter(([name, prev]) => {
          const cur = stats.find((s) => s.indexName === name)?.scans;
          return cur !== undefined && cur >= prev;
        })
      )
    : undefined;

  const candidates = findUnusedIndexCandidates(stats, {
    minObservationDays: UNUSED_INDEX_MIN_OBSERVATION_DAYS,
    maxScans: UNUSED_INDEX_MAX_SCANS,
    requiredIdleObservations: previous ? 2 : 1,
    previousScans,
  });

  const report = buildUnusedIndexReport(stats, candidates, UNUSED_INDEX_MIN_OBSERVATION_DAYS);

  await saveSnapshot(
    {
      takenAt: new Date().toISOString(),
      scans: Object.fromEntries(stats.map((s) => [s.indexName, s.scans])),
    },
    overrides.snapshotFile ?? snapshotPath()
  );

  const config = loadConfig();
  const recipients =
    overrides.recipients ??
    String(process.env.UNUSED_INDEX_DIGEST_RECIPIENTS ?? config.complianceAlertEmail ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);

  let emailed = 0;
  if (report.candidates.length > 0 && recipients.length > 0) {
    const html = buildReportHtml(report);
    const subject = `RemitMortgage — Unused Index Report (${report.candidates.length} candidates, ~${formatBytes(report.totalReclaimableBytes)} reclaimable)`;
    for (const to of recipients) {
      try {
        if (await sendEmail(to, subject, html)) emailed += 1;
      } catch (err) {
        logger.warn("[unused-index-audit] Failed to email report", { to, err });
      }
    }
  } else {
    logger.info(
      `[unused-index-audit] Scanned ${stats.length} indexes, ${candidates.length} candidates; ` +
        (recipients.length === 0 ? "no recipients configured, skipping email." : "nothing to report.")
    );
  }

  try {
    await (prisma as any).auditLog?.create?.({
      data: {
        action: "UNUSED_INDEX_AUDIT_REPORT",
        actorAddress: "system:scheduler",
        metadata: {
          generatedAt: report.generatedAt,
          indexesScanned: report.indexesScanned,
          candidates: report.candidates.map((c) => ({
            indexName: c.indexName,
            table: c.table,
            columns: c.columns,
            sizeBytes: c.sizeBytes,
            scans: c.scans,
            reason: c.reason,
          })),
          excludedConstraintIndexes: report.excludedConstraintIndexes,
        },
      },
    });
  } catch (err) {
    logger.warn("[unused-index-audit] Non-blocking failure persisting audit log entry", { err });
  }

  return { report, emailed };
}
