// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

/**
 * Automated Deadlock Detection
 * 
 * Captures deadlock events or lock contentions as they occur, identifying 
 * conflicting queries/tables.
 */
export async function runDeadlockDetectionJob() {
  try {
    // Postgres query to find queries waiting for locks
    const locks: any[] = await prisma.$queryRaw`
      SELECT
        blocked_locks.pid     AS blocked_pid,
        blocked_activity.usename  AS blocked_user,
        blocking_locks.pid     AS blocking_pid,
        blocking_activity.usename AS blocking_user,
        blocked_activity.query    AS blocked_statement,
        blocking_activity.query   AS current_statement_in_blocking_process
      FROM  pg_catalog.pg_locks         blocked_locks
      JOIN pg_catalog.pg_stat_activity blocked_activity  ON blocked_activity.pid = blocked_locks.pid
      JOIN pg_catalog.pg_locks         blocking_locks 
          ON blocking_locks.locktype = blocked_locks.locktype
          AND blocking_locks.DATABASE IS NOT DISTINCT FROM blocked_locks.DATABASE
          AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
          AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
          AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
          AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
          AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
          AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
          AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
          AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
          AND blocking_locks.pid != blocked_locks.pid
      JOIN pg_catalog.pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
      WHERE NOT blocked_locks.GRANTED;
    `;

    if (locks && locks.length > 0) {
      logger.error("[DeadlockDetection] Lock contention/deadlock detected!", {
        contentions: locks.map(lock => ({
          blockedPid: lock.blocked_pid,
          blockingPid: lock.blocking_pid,
          blockedQuery: lock.blocked_statement,
          blockingQuery: lock.current_statement_in_blocking_process
        }))
      });
      // Further steps: track frequency by table and trigger PagerDuty/Slack alert
    }
  } catch (err) {
    logger.error("[DeadlockDetection] Failed to check for deadlocks", { 
      error: err instanceof Error ? err.message : String(err)
    });
  }
}
