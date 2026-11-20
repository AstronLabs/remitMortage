// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * In-memory record of requests that exceed their route's latency budget
 * (issue #988). `middleware/metricsMiddleware.ts` feeds every completed
 * request here; the admin summary endpoint reads the ranked result.
 *
 * The map is bounded because it is keyed by route template: if a new-bucket
 * key would exceed {@link MAX_TRACKED_ROUTES}, samples for it are ignored
 * rather than growing memory without limit. Process-local by design — the
 * Prometheus counter is the cross-replica source of truth.
 */

import logger from "../utils/logger.js";
import { routeLatencyBudgetExceededTotal } from "./metrics.js";

export interface LatencySample {
  method: string;
  route: string;
  durationMs: number;
  budgetMs: number;
  /** Correlation ID of the request, logged with the warning. */
  requestId?: string;
}

export interface RouteLatencyStats {
  method: string;
  route: string;
  budgetMs: number;
  requests: number;
  exceeded: number;
  /** Exceeded / requests, rounded to four decimals. */
  exceededRatio: number;
  maxDurationMs: number;
  lastExceededAt: string | null;
}

export const MAX_TRACKED_ROUTES = 500;

interface MutableStats {
  method: string;
  route: string;
  budgetMs: number;
  requests: number;
  exceeded: number;
  maxDurationMs: number;
  lastExceededAt: Date | null;
}

const tracked = new Map<string, MutableStats>();
let droppedRoutes = 0;

function keyOf(method: string, route: string): string {
  return `${method.toUpperCase()} ${route}`;
}

/** Feed one completed request into the budget monitor. */
export function recordLatencySample(sample: LatencySample): void {
  const method = sample.method.toUpperCase();
  const key = keyOf(method, sample.route);
  let stats = tracked.get(key);

  if (!stats) {
    if (tracked.size >= MAX_TRACKED_ROUTES) {
      droppedRoutes++;
      if (droppedRoutes === 1) {
        logger.warn("[latency-budget] route stats limit reached; dropping new routes", {
          limit: MAX_TRACKED_ROUTES,
        });
      }
      return;
    }
    stats = {
      method,
      route: sample.route,
      budgetMs: sample.budgetMs,
      requests: 0,
      exceeded: 0,
      maxDurationMs: 0,
      lastExceededAt: null,
    };
    tracked.set(key, stats);
  }

  stats.budgetMs = sample.budgetMs;
  stats.requests++;
  stats.maxDurationMs = Math.max(stats.maxDurationMs, sample.durationMs);

  if (sample.durationMs > sample.budgetMs) {
    stats.exceeded++;
    stats.lastExceededAt = new Date();
    routeLatencyBudgetExceededTotal.inc({ method, route: sample.route });
    logger.warn("[latency-budget] request exceeded its route budget", {
      method,
      route: sample.route,
      durationMs: Math.round(sample.durationMs),
      budgetMs: sample.budgetMs,
      requestId: sample.requestId,
    });
  }
}

/** Routes that have exceeded their budget, most frequent first. */
export function getLatencyBudgetViolations(): RouteLatencyStats[] {
  return [...tracked.values()]
    .filter((stats) => stats.exceeded > 0)
    .map<RouteLatencyStats>((stats) => ({
      method: stats.method,
      route: stats.route,
      budgetMs: stats.budgetMs,
      requests: stats.requests,
      exceeded: stats.exceeded,
      exceededRatio: Math.round((stats.exceeded / stats.requests) * 10_000) / 10_000,
      maxDurationMs: Math.round(stats.maxDurationMs),
      lastExceededAt: stats.lastExceededAt?.toISOString() ?? null,
    }))
    .sort((a, b) => b.exceeded - a.exceeded || b.exceededRatio - a.exceededRatio || a.route.localeCompare(b.route));
}

/** Test hook. */
export function _resetLatencyBudgetMonitor(): void {
  tracked.clear();
  droppedRoutes = 0;
}
