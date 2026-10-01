// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated unused-index detection (issue #758).
 *
 * Indexes accumulate as features land; nothing tracked which ones real query
 * patterns still use. This module holds the pure, testable core:
 * - {@link findUnusedIndexCandidates} flags indexes with zero/negligible
 *   scans over a sustained observation window, with enough context
 *   (table, columns, size, last-used data) for a human to decide on removal.
 * - Constraint-backing indexes (primary key / unique) are NEVER removal
 *   candidates, regardless of observed scan activity.
 *
 * Removal itself is always a human decision — see
 * `docs/UNUSED_INDEX_REVIEW.md`. The scheduled job (`jobs/unusedIndexAudit.ts`)
 * only reports.
 */

export interface IndexUsageStat {
  /** Schema-qualified table, e.g. "public.LoanApplication". */
  table: string;
  /** Index name, e.g. "LoanApplication_status_idx". */
  indexName: string;
  /** Indexed columns in order. */
  columns: string[];
  /** Number of index scans observed in the window. */
  scans: number;
  /** Number of rows returned by those scans (0 when scans === 0). */
  tuplesRead: number;
  /** Index size in bytes (pg_relation_size). */
  sizeBytes: number;
  /** Last time the index was observed being scanned, if known. */
  lastUsedAt: Date | null;
  /** How long this index has been under observation. */
  observedForDays: number;
  /** True when the index backs a primary-key or unique constraint. */
  isConstraintBacked: boolean;
  /** Constraint kind when `isConstraintBacked`, e.g. "PRIMARY KEY" / "UNIQUE". */
  constraintKind?: string;
  /** Index definition (pg_get_indexdef), for the review report. */
  definition?: string;
}

export interface UnusedIndexCandidate extends IndexUsageStat {
  /** Why this index was flagged. */
  reason: string;
  /** Consecutive low-usage observations backing the "sustained" claim. */
  consecutiveIdleObservations: number;
}

export interface FindUnusedIndexesOptions {
  /** Minimum observation window before an index can be flagged (days). Default 14. */
  minObservationDays?: number;
  /** Scan count at or below which usage is "negligible". Default 0. */
  maxScans?: number;
  /** Consecutive idle observations required to claim "sustained". Default 2. */
  requiredIdleObservations?: number;
  /**
   * Previous observation counts by index name (scan totals from the last
   * scheduled run). Indexes idle in both the previous and current window
   * count as sustained. Omitted → single-window evaluation.
   */
  previousScans?: Readonly<Record<string, number>>;
}

/** Constraint-backing indexes are never removal candidates, full stop. */
export function isConstraintBacked(stat: Pick<IndexUsageStat, "isConstraintBacked">): boolean {
  return stat.isConstraintBacked === true;
}

export function findUnusedIndexCandidates(
  stats: readonly IndexUsageStat[],
  options: FindUnusedIndexesOptions = {}
): UnusedIndexCandidate[] {
  const {
    minObservationDays = 14,
    maxScans = 0,
    requiredIdleObservations = 2,
    previousScans,
  } = options;

  const candidates: UnusedIndexCandidate[] = [];

  for (const stat of stats) {
    // Acceptance criterion: constraint-backing indexes are never flagged,
    // regardless of observed scan activity.
    if (isConstraintBacked(stat)) continue;
    if (stat.observedForDays < minObservationDays) continue;
    if (stat.scans > maxScans) continue;

    const prev = previousScans?.[stat.indexName];
    const idleBefore = prev === undefined ? 1 : prev <= maxScans ? 1 : 0;
    // Current window is idle (scans <= maxScans checked above) → +1.
    const consecutiveIdleObservations = prev === undefined ? 1 : idleBefore + 1;

    if (consecutiveIdleObservations < requiredIdleObservations) continue;

    const sizeLabel =
      stat.sizeBytes >= 1024 * 1024
        ? `${(stat.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
        : `${Math.max(1, Math.round(stat.sizeBytes / 1024))} KB`;
    candidates.push({
      ...stat,
      consecutiveIdleObservations,
      reason:
        `zero/negligible scans (${stat.scans}) over ${stat.observedForDays}d of observation ` +
        `(${consecutiveIdleObservations} consecutive idle observations), reclaimable ~${sizeLabel}`,
    });
  }

  candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return candidates;
}

export interface UnusedIndexReport {
  generatedAt: string;
  observationDays: number;
  indexesScanned: number;
  candidates: UnusedIndexCandidate[];
  /** Constraint-backed indexes seen but deliberately excluded. */
  excludedConstraintIndexes: string[];
  totalReclaimableBytes: number;
}

export function buildUnusedIndexReport(
  stats: readonly IndexUsageStat[],
  candidates: readonly UnusedIndexCandidate[],
  observationDays: number
): UnusedIndexReport {
  return {
    generatedAt: new Date().toISOString(),
    observationDays,
    indexesScanned: stats.length,
    candidates: [...candidates],
    excludedConstraintIndexes: stats.filter(isConstraintBacked).map((s) => s.indexName),
    totalReclaimableBytes: candidates.reduce((sum, c) => sum + c.sizeBytes, 0),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
