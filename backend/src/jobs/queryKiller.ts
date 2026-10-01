// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated long-running query killer for runaway transactions (issue #736).
 *
 * An unbounded query (missing WHERE clause, unindexed join, app bug) can hold
 * locks and consume resources indefinitely. This scheduled job finds
 * `pg_stat_activity` backends running past a configurable duration threshold
 * and terminates them with `pg_terminate_backend` — except explicitly
 * allowlisted maintenance jobs — then logs and alerts with enough context
 * (query text, origin, duration) to diagnose the root cause.
 */

import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

export interface LongRunningQuery {
  pid: number;
  durationMs: number;
  state: string | null;
  query: string | null;
  usename: string | null;
  applicationName: string | null;
  clientAddr: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  xactStart: Date | null;
  queryStart: Date | null;
}

/** Default kill threshold when QUERY_KILLER_THRESHOLD_MS is unset (5 min). */
export const DEFAULT_QUERY_KILLER_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Explicitly documented allowlist of known-long-running maintenance jobs that
 * must NEVER be terminated (matched case-insensitively as substrings of the
 * query text, plus application-name matches).
 */
export const QUERY_KILLER_ALLOWLIST: string[] = [
  "pg_dump",
  "pg_basebackup",
  "VACUUM",
  "ANALYZE",
  "REINDEX",
  "partition_manager",
  "analytics_refresh",
  "materialized view refresh",
];

export function getQueryKillerThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.QUERY_KILLER_THRESHOLD_MS ?? DEFAULT_QUERY_KILLER_THRESHOLD_MS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_QUERY_KILLER_THRESHOLD_MS;
}

export function getQueryKillerAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.QUERY_KILLER_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...QUERY_KILLER_ALLOWLIST, ...extra];
}

/** True when the query matches the documented maintenance allowlist. */
export function isAllowlisted(query: string | null, applicationName: string | null, allowlist: string[] = QUERY_KILLER_ALLOWLIST): boolean {
  const haystacks = [query ?? "", applicationName ?? ""].map((s) => s.toLowerCase());
  return allowlist.some((entry) => {
    const needle = entry.toLowerCase();
    return haystacks.some((h) => h.includes(needle));
  });
}

/** Pure selection: which candidates exceed the threshold and are not allowlisted. */
export function selectQueriesToKill(
  rows: LongRunningQuery[],
  thresholdMs: number,
  allowlist: string[] = QUERY_KILLER_ALLOWLIST
): LongRunningQuery[] {
  return rows.filter(
    (r) => r.durationMs >= thresholdMs && !isAllowlisted(r.query, r.applicationName, allowlist)
  );
}

export interface QueryKillerDeps {
  findCandidates?: (thresholdMs: number) => Promise<LongRunningQuery[]>;
  terminate?: (pid: number) => Promise<boolean>;
  alert?: (killed: LongRunningQuery, thresholdMs: number) => Promise<void> | void;
  thresholdMs?: number;
  allowlist?: string[];
}

export interface QueryKillerResult {
  scanned: number;
  killed: number;
  skippedAllowlisted: number;
  failed: number;
  killedPids: number[];
}

async function defaultFindCandidates(thresholdMs: number): Promise<LongRunningQuery[]> {
  const rows = await prisma.$queryRaw<LongRunningQuery[]>`
    SELECT
      pid,
      EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000 AS "durationMs",
      state,
      query,
      usename,
      application_name AS "applicationName",
      client_addr::text AS "clientAddr",
      wait_event_type AS "waitEventType",
      wait_event AS "waitEvent",
      xact_start AS "xactStart",
      query_start AS "queryStart"
    FROM pg_stat_activity
    WHERE state <> 'idle'
      AND pid <> pg_backend_pid()
      AND query_start IS NOT NULL
      AND (clock_timestamp() - query_start) > ((${thresholdMs}::bigint * INTERVAL '1 millisecond'))
    ORDER BY query_start ASC;
  `;
  return (rows as any[]).map((r) => ({
    ...r,
    pid: Number((r as any).pid),
    durationMs: Number((r as any).durationMs),
  }));
}

async function defaultTerminate(pid: number): Promise<boolean> {
  const result = await prisma.$queryRaw<Array<{ pg_terminate_backend: boolean }>>`
    SELECT pg_terminate_backend(${pid}::int);
  `;
  return (result as any[])?.[0]?.pg_terminate_backend === true;
}

async function defaultAlert(killed: LongRunningQuery, thresholdMs: number): Promise<void> {
  logger.error("[query-killer] auto-terminated runaway query", {
    pid: killed.pid,
    durationMs: Math.round(killed.durationMs),
    thresholdMs,
    usename: killed.usename,
    applicationName: killed.applicationName,
    clientAddr: killed.clientAddr,
    waitEventType: killed.waitEventType,
    waitEvent: killed.waitEvent,
    queryPreview: (killed.query ?? "").slice(0, 2000),
  });
}

/**
 * Scan for runaway queries and terminate those past the threshold.
 * Every auto-terminated query is logged/alerted with origin context;
 * allowlisted maintenance jobs are never touched.
 */
export async function runQueryKillerJob(deps: QueryKillerDeps = {}): Promise<QueryKillerResult> {
  const thresholdMs = deps.thresholdMs ?? getQueryKillerThresholdMs();
  const allowlist = deps.allowlist ?? getQueryKillerAllowlist();
  const findCandidates = deps.findCandidates ?? defaultFindCandidates;
  const terminate = deps.terminate ?? defaultTerminate;
  const alert = deps.alert ?? defaultAlert;

  let rows: LongRunningQuery[] = [];
  try {
    rows = await findCandidates(thresholdMs);
  } catch (err) {
    logger.error("[query-killer] candidate scan failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { scanned: 0, killed: 0, skippedAllowlisted: 0, failed: 0, killedPids: [] };
  }

  const toKill = selectQueriesToKill(rows, thresholdMs, allowlist);
  const skippedAllowlisted = rows.length - toKill.length;

  let killed = 0;
  let failed = 0;
  const killedPids: number[] = [];
  for (const q of toKill) {
    try {
      const ok = await terminate(q.pid);
      if (ok) {
        killed += 1;
        killedPids.push(q.pid);
      } else {
        failed += 1;
        logger.warn("[query-killer] terminate returned false", { pid: q.pid });
        continue;
      }
    } catch (err) {
      failed += 1;
      logger.error("[query-killer] terminate failed", {
        pid: q.pid,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    try {
      await alert(q, thresholdMs);
    } catch (err) {
      logger.warn("[query-killer] alert sink threw", { err });
    }
  }

  if (killed > 0 || failed > 0) {
    logger.info(`[query-killer] scanned=${rows.length} killed=${killed} failed=${failed} skippedAllowlisted=${skippedAllowlisted}`);
  }
  return { scanned: rows.length, killed, skippedAllowlisted, failed, killedPids };
}
