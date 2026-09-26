// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";

/**
 * Volume-based rate limiting for bulk data export endpoints.
 *
 * The request-count limiters in rateLimit.ts treat a 5-row response and a
 * 5,000-row response the same. Export consumers are instead budgeted on the
 * cumulative number of rows they pull per API key over a rolling window, so a
 * single integrator repeatedly draining large result sets gets throttled
 * before it turns into a database load spike.
 */

export interface ExportQuotaConfig {
  /** Rolling window length in milliseconds. */
  windowMs: number;
  /** Row quota for scopes without an explicit override. */
  defaultMaxRows: number;
  /** Per-scope row quota overrides, keyed by API key scope (e.g. "export:transactions"). */
  maxRowsByScope: Record<string, number>;
}

/**
 * Parses `EXPORT_QUOTA_BY_SCOPE`, a comma-separated list of `scope=rows`
 * pairs (e.g. "export:transactions=50000,export:analytics=10000").
 * Malformed or non-positive entries are ignored.
 */
export function parseScopeQuotas(raw: string | undefined): Record<string, number> {
  const quotas: Record<string, number> = {};
  if (!raw) return quotas;
  for (const pair of raw.split(",")) {
    const separator = pair.lastIndexOf("=");
    if (separator <= 0) continue;
    const scope = pair.slice(0, separator).trim();
    const rows = parseInt(pair.slice(separator + 1).trim(), 10);
    if (scope && Number.isFinite(rows) && rows > 0) quotas[scope] = rows;
  }
  return quotas;
}

export function loadExportQuotaConfig(env: NodeJS.ProcessEnv = process.env): ExportQuotaConfig {
  const windowMs = parseInt(env.EXPORT_QUOTA_WINDOW_MS || "", 10);
  const defaultMaxRows = parseInt(env.EXPORT_QUOTA_DEFAULT_ROWS || "", 10);
  return {
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60 * 60 * 1000,
    defaultMaxRows: Number.isFinite(defaultMaxRows) && defaultMaxRows > 0 ? defaultMaxRows : 50_000,
    maxRowsByScope: parseScopeQuotas(env.EXPORT_QUOTA_BY_SCOPE),
  };
}

interface UsageEntry {
  at: number;
  rows: number;
}

/** In-memory rolling-window tally of exported rows per consumer key. */
export class ExportQuotaTracker {
  private readonly usage = new Map<string, UsageEntry[]>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private entries(key: string): UsageEntry[] {
    const cutoff = this.now() - this.windowMs;
    const live = (this.usage.get(key) ?? []).filter((entry) => entry.at > cutoff);
    if (live.length > 0) this.usage.set(key, live);
    else this.usage.delete(key);
    return live;
  }

  used(key: string): number {
    return this.entries(key).reduce((total, entry) => total + entry.rows, 0);
  }

  record(key: string, rows: number): void {
    if (!Number.isFinite(rows) || rows <= 0) return;
    const live = this.entries(key);
    live.push({ at: this.now(), rows });
    this.usage.set(key, live);
  }

  /**
   * Seconds until enough of the oldest usage ages out of the window for the
   * key to drop back under `maxRows`. Returns 0 when already under quota.
   */
  retryAfterSeconds(key: string, maxRows: number): number {
    const live = this.entries(key);
    let used = live.reduce((total, entry) => total + entry.rows, 0);
    if (used < maxRows) return 0;
    for (const entry of live) {
      used -= entry.rows;
      if (used < maxRows) {
        return Math.max(1, Math.ceil((entry.at + this.windowMs - this.now()) / 1000));
      }
    }
    return Math.max(1, Math.ceil(this.windowMs / 1000));
  }
}

/**
 * Records the number of rows an export handler is about to return against the
 * caller's quota. No-op if the route is not behind `exportRateLimiter`.
 */
export function recordExportedRows(res: Response, rows: number): void {
  const record = res.locals.recordExportedRows as ((rows: number) => void) | undefined;
  record?.(rows);
}

/**
 * Rejects the request with 429 + `Retry-After` once the caller's API key has
 * exported at least its scope's row quota within the rolling window. Must be
 * mounted after `requireScopedApiKey`, which exposes the key on `res.locals`.
 */
export function exportRateLimiter(
  scope: string,
  config: ExportQuotaConfig = loadExportQuotaConfig(),
  tracker: ExportQuotaTracker = new ExportQuotaTracker(config.windowMs),
) {
  const maxRows = config.maxRowsByScope[scope] ?? config.defaultMaxRows;

  return (req: Request, res: Response, next: NextFunction) => {
    const consumer = (res.locals.apiKey as { id?: string } | undefined)?.id ?? req.ip ?? "unknown";
    const key = `${consumer}:${scope}`;
    const used = tracker.used(key);

    res.setHeader("X-Export-Quota-Limit", String(maxRows));
    res.setHeader("X-Export-Quota-Remaining", String(Math.max(0, maxRows - used)));

    if (used >= maxRows) {
      const retryAfter = tracker.retryAfterSeconds(key, maxRows);
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({
        error: "export_quota_exceeded",
        message: `Export quota of ${maxRows} rows per ${Math.ceil(config.windowMs / 1000)}s exceeded for scope ${scope}`,
        retryAfter,
        statusCode: 429,
      });
      return;
    }

    res.locals.recordExportedRows = (rows: number) => tracker.record(key, rows);
    next();
  };
}
