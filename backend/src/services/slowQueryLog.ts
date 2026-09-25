// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated slow query logging (issue #583).
 *
 * Every Prisma operation that outruns a configurable duration threshold is
 * captured and persisted, then rolled up into a weekly digest. The threshold is
 * read from `SLOW_QUERY_THRESHOLD_MS` (default {@link DEFAULT_SLOW_QUERY_THRESHOLD_MS}).
 *
 * ── Why a Prisma extension and not Postgres `log_min_duration_statement` ─────
 *
 * The server-side GUC only writes to the database's own log file, which the
 * application cannot query for a digest without shipping log files around. This
 * project already instruments every ORM operation through a Prisma client
 * extension for pool metrics (`dbPoolMetrics.ts`), so slow-query capture rides
 * the same hook. That keeps the captured data in Postgres, next to everything
 * else, and makes per-pattern aggregation a plain GROUP BY.
 *
 * Literals are stripped before storage so the log holds query *patterns* rather
 * than the values that happened to be bound — no PII and stable grouping.
 */

import { createHash } from "crypto";

import logger from "../utils/logger.js";

/** Prisma model that backs the slow-query log itself. */
export const SLOW_QUERY_LOG_MODEL = "SlowQueryLog";

/** Default threshold when `SLOW_QUERY_THRESHOLD_MS` is unset or invalid. */
export const DEFAULT_SLOW_QUERY_THRESHOLD_MS = 200;

/** A captured slow operation, persisted by a {@link SlowQueryStore}. */
export interface SlowQueryRecord {
  /** Normalized query pattern with literals replaced by placeholders. */
  query: string;
  /** Stable hash of the normalized pattern; groups equivalent statements. */
  fingerprint: string;
  /** Prisma model, or null for non-model operations. */
  model: string | null;
  /** Prisma operation name (e.g. `findMany`), or null when unknown. */
  operation: string | null;
  /** Wall-clock duration in milliseconds (rounded). */
  durationMs: number;
  /** When the operation completed. */
  occurredAt: Date;
}

/** Persistence boundary for slow queries. Injectable for tests. */
export interface SlowQueryStore {
  record(entry: SlowQueryRecord): Promise<void>;
  findSince(since: Date, until?: Date): Promise<SlowQueryRecord[]>;
}

/**
 * Reads the configured threshold in milliseconds. Non-positive or malformed
 * values fall back to the default so a typo can never disable capture.
 */
export function getSlowQueryThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SLOW_QUERY_THRESHOLD_MS;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SLOW_QUERY_THRESHOLD_MS;
}

/**
 * Canonicalizes a statement into a stable pattern by replacing literals with
 * placeholders and collapsing whitespace. Used as the grouping key so
 * `WHERE id = 1` and `WHERE id = 2` aggregate together.
 */
export function normalizeQuery(query: string): string {
  return query
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/IN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, "IN (?)")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;+$/, "")
    .trim();
}

/** Hashes a normalized query pattern into its fingerprint. */
export function fingerprintQuery(query: string): string {
  return createHash("sha256").update(normalizeQuery(query)).digest("hex");
}

export interface SlowQueryCandidate {
  query: string;
  durationMs: number;
  thresholdMs: number;
  model?: string | null;
  operation?: string | null;
  occurredAt?: Date;
}

/**
 * Builds a persistable record from a measured operation, or returns null when
 * the operation ran within budget or the pattern is empty.
 */
export function createSlowQueryEntry(candidate: SlowQueryCandidate): SlowQueryRecord | null {
  const { query, durationMs, thresholdMs } = candidate;
  if (!Number.isFinite(durationMs) || durationMs < thresholdMs) return null;

  const normalized = normalizeQuery(query);
  if (!normalized) return null;

  return {
    query: normalized,
    fingerprint: fingerprintQuery(normalized),
    model: candidate.model ?? null,
    operation: candidate.operation ?? null,
    durationMs: Math.round(durationMs),
    occurredAt: candidate.occurredAt ?? new Date(),
  };
}

/** True for the log's own model, which is never itself logged as slow. */
export function isIgnoredModel(model: string | null | undefined): boolean {
  return model === SLOW_QUERY_LOG_MODEL;
}

/** Persists slow queries through Prisma. */
export function createPrismaSlowQueryStore(prisma: {
  slowQueryLog: {
    create: (args: { data: SlowQueryRecord }) => Promise<unknown>;
    findMany: (args: {
      where: { occurredAt: { gte: Date; lt?: Date } };
      orderBy: { occurredAt: "asc" | "desc" };
    }) => Promise<SlowQueryRecord[]>;
  };
}): SlowQueryStore {
  return {
    async record(entry) {
      await prisma.slowQueryLog.create({ data: entry });
    },
    async findSince(since, until) {
      return prisma.slowQueryLog.findMany({
        where: { occurredAt: until ? { gte: since, lt: until } : { gte: since } },
        orderBy: { occurredAt: "asc" },
      });
    },
  };
}

/** In-memory store used by tests and as an offline fallback. */
export function createMemorySlowQueryStore(
  initial: SlowQueryRecord[] = []
): SlowQueryStore & { entries: SlowQueryRecord[]; clear: () => void } {
  const entries = [...initial];
  return {
    entries,
    async record(entry) {
      entries.push(entry);
    },
    async findSince(since, until) {
      return entries.filter(
        (entry) => entry.occurredAt >= since && (!until || entry.occurredAt < until)
      );
    },
    clear() {
      entries.length = 0;
    },
  };
}

export interface SlowQueryLoggingExtensionOptions {
  thresholdMs?: number;
  /** Invoked for every operation that exceeds the threshold. */
  onSlowQuery: (entry: SlowQueryRecord) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/**
 * Prisma client extension that times every model operation and hands the ones
 * over budget to `onSlowQuery`. Written as a factory returning a plain object
 * (like `createDbPoolMetricsExtension`) so it stays unit-testable without a
 * generated client or a live database.
 */
export function createSlowQueryLoggingExtension(
  options: SlowQueryLoggingExtensionOptions
) {
  const thresholdMs = options.thresholdMs ?? getSlowQueryThresholdMs();
  const now = options.now ?? (() => new Date());

  return {
    name: "remitmortgage-slow-query-log",
    query: {
      $allModels: {
        async $allOperations({
          model,
          operation,
          args,
          query,
        }: {
          model?: string;
          operation: string;
          args: unknown;
          query: (args: unknown) => Promise<unknown>;
        }) {
          // Never measure the insert that records slow queries — that would
          // recurse for as long as the log table itself is slow to write.
          if (isIgnoredModel(model)) return query(args);

          const startedAt = process.hrtime.bigint();
          try {
            return await query(args);
          } finally {
            const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
            const entry = createSlowQueryEntry({
              query: `${model ?? "raw"}.${operation}`,
              model: model ?? null,
              operation,
              durationMs,
              thresholdMs,
              occurredAt: now(),
            });
            if (entry) {
              try {
                options.onSlowQuery(entry);
              } catch (error) {
                logger.warn("[slow-query] Failed to capture slow query", { error });
              }
            }
          }
        },
      },
    },
  };
}
