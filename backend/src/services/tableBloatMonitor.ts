// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated table bloat monitoring and VACUUM scheduling (issue #684).
 *
 * High-churn tables (transaction logs, session tokens, notification records)
 * can accumulate dead-tuple bloat between autovacuum cycles under load. This
 * scans `pg_stat_user_tables` for the dead-tuple ratio of every table,
 * persists a snapshot for visibility, and manually VACUUMs any table whose
 * ratio has crossed the critical threshold rather than waiting for
 * autovacuum to catch up.
 */

import { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "./db.js";
import logger from "../utils/logger.js";

export interface RawTableStat {
  schema_name: string;
  table_name: string;
  live_tuples: bigint;
  dead_tuples: bigint;
  table_size_bytes: bigint;
  last_autovacuum: Date | null;
  last_vacuum: Date | null;
}

export interface TableBloatStat {
  schemaName: string;
  tableName: string;
  liveTuples: bigint;
  deadTuples: bigint;
  deadTupleRatio: number;
  tableSizeBytes: bigint;
  lastAutovacuum: Date | null;
  lastVacuum: Date | null;
}

export interface TableBloatThresholds {
  /** Ratio at which a table is flagged as bloated but left to autovacuum. Defaults to 0.2. */
  warnRatio: number;
  /** Ratio at which the monitor manually VACUUMs the table. Defaults to 0.4. */
  criticalRatio: number;
  /** Minimum dead tuples before a table is considered at all, to avoid noise on tiny tables. Defaults to 1000. */
  minDeadTuples: number;
}

export function getConfiguredThresholds(): TableBloatThresholds {
  return {
    warnRatio: Number(process.env.TABLE_BLOAT_WARN_RATIO ?? 0.2),
    criticalRatio: Number(process.env.TABLE_BLOAT_CRITICAL_RATIO ?? 0.4),
    minDeadTuples: Number(process.env.TABLE_BLOAT_MIN_DEAD_TUPLES ?? 1000),
  };
}

/** Postgres identifiers this monitor will treat as safe to interpolate into a VACUUM statement. */
const SAFE_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdentifier(identifier: string): string {
  if (!SAFE_IDENTIFIER.test(identifier)) {
    throw new Error(`Refusing to quote unsafe identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

/** Reads dead-tuple stats for every user table from pg_stat_user_tables. */
export async function fetchTableBloatStats(
  prismaClient: PrismaClient = defaultPrisma
): Promise<TableBloatStat[]> {
  const rows = await prismaClient.$queryRaw<RawTableStat[]>(Prisma.sql`
    SELECT
      schemaname AS schema_name,
      relname AS table_name,
      n_live_tup AS live_tuples,
      n_dead_tup AS dead_tuples,
      pg_total_relation_size(relid) AS table_size_bytes,
      last_autovacuum,
      last_vacuum
    FROM pg_stat_user_tables
    ORDER BY n_dead_tup DESC;
  `);

  return rows.map((row) => {
    const live = BigInt(row.live_tuples ?? 0);
    const dead = BigInt(row.dead_tuples ?? 0);
    const total = live + dead;
    return {
      schemaName: row.schema_name,
      tableName: row.table_name,
      liveTuples: live,
      deadTuples: dead,
      deadTupleRatio: total > 0n ? Number(dead) / Number(total) : 0,
      tableSizeBytes: BigInt(row.table_size_bytes ?? 0),
      lastAutovacuum: row.last_autovacuum,
      lastVacuum: row.last_vacuum,
    };
  });
}

/** Runs a manual VACUUM (ANALYZE) against a single table. Cannot run inside a transaction. */
export async function vacuumTable(
  schemaName: string,
  tableName: string,
  prismaClient: PrismaClient = defaultPrisma
): Promise<void> {
  const qualified = `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`;
  await prismaClient.$executeRawUnsafe(`VACUUM (ANALYZE) ${qualified};`);
}

export interface TableBloatFinding extends TableBloatStat {
  level: "warn" | "critical";
  vacuumTriggered: boolean;
}

export interface TableBloatScanResult {
  scannedAt: Date;
  tablesScanned: number;
  findings: TableBloatFinding[];
}

export interface RunTableBloatScanOptions {
  prisma?: PrismaClient;
  thresholds?: Partial<TableBloatThresholds>;
  /** Skip issuing VACUUM even for critical tables; still records the finding. Defaults to false. */
  dryRun?: boolean;
}

/**
 * Scans every user table for dead-tuple bloat, persists a snapshot per table
 * above `minDeadTuples`, and manually VACUUMs tables at or above the
 * critical ratio.
 */
export async function runTableBloatScan(
  options: RunTableBloatScanOptions = {}
): Promise<TableBloatScanResult> {
  const prismaClient = options.prisma ?? defaultPrisma;
  const thresholds = { ...getConfiguredThresholds(), ...options.thresholds };
  const scannedAt = new Date();

  const stats = await fetchTableBloatStats(prismaClient);
  const findings: TableBloatFinding[] = [];

  for (const stat of stats) {
    if (stat.deadTuples < BigInt(thresholds.minDeadTuples)) continue;
    if (stat.deadTupleRatio < thresholds.warnRatio) continue;

    const level: "warn" | "critical" =
      stat.deadTupleRatio >= thresholds.criticalRatio ? "critical" : "warn";

    let vacuumTriggered = false;
    if (level === "critical" && !options.dryRun) {
      try {
        await vacuumTable(stat.schemaName, stat.tableName, prismaClient);
        vacuumTriggered = true;
        logger.warn(
          `[table-bloat-monitor] Manually VACUUMed ${stat.schemaName}.${stat.tableName} (dead tuple ratio ${(stat.deadTupleRatio * 100).toFixed(1)}%)`
        );
      } catch (error) {
        logger.error(
          `[table-bloat-monitor] Failed to VACUUM ${stat.schemaName}.${stat.tableName}`,
          { error }
        );
      }
    }

    findings.push({ ...stat, level, vacuumTriggered });

    try {
      await prismaClient.tableBloatSnapshot.create({
        data: {
          schemaName: stat.schemaName,
          tableName: stat.tableName,
          liveTuples: stat.liveTuples,
          deadTuples: stat.deadTuples,
          deadTupleRatio: stat.deadTupleRatio,
          tableSizeBytes: stat.tableSizeBytes,
          lastAutovacuum: stat.lastAutovacuum,
          lastVacuum: stat.lastVacuum,
          vacuumTriggered,
          capturedAt: scannedAt,
        },
      });
    } catch (error) {
      logger.error(
        `[table-bloat-monitor] Failed to persist bloat snapshot for ${stat.schemaName}.${stat.tableName}`,
        { error }
      );
    }
  }

  return { scannedAt, tablesScanned: stats.length, findings };
}

/** Returns the most recent snapshot per table, most bloated first. Used by the admin dashboard. */
export async function getLatestTableBloatSnapshots(
  prismaClient: PrismaClient = defaultPrisma,
  limit = 50
) {
  const rows = await prismaClient.$queryRaw<
    Array<{
      tableName: string;
      schemaName: string;
      liveTuples: bigint;
      deadTuples: bigint;
      deadTupleRatio: number;
      tableSizeBytes: bigint;
      lastAutovacuum: Date | null;
      lastVacuum: Date | null;
      vacuumTriggered: boolean;
      capturedAt: Date;
    }>
  >(Prisma.sql`
    SELECT DISTINCT ON ("tableName")
      "tableName", "schemaName", "liveTuples", "deadTuples", "deadTupleRatio",
      "tableSizeBytes", "lastAutovacuum", "lastVacuum", "vacuumTriggered", "capturedAt"
    FROM "TableBloatSnapshot"
    ORDER BY "tableName", "capturedAt" DESC
    LIMIT ${limit};
  `);

  return rows
    .map((row) => ({
      ...row,
      liveTuples: row.liveTuples.toString(),
      deadTuples: row.deadTuples.toString(),
      tableSizeBytes: row.tableSizeBytes.toString(),
    }))
    .sort((a, b) => b.deadTupleRatio - a.deadTupleRatio);
}
