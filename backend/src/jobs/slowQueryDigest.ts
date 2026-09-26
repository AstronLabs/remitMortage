// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Weekly slow query digest (issue #583).
 *
 * Rolls the last week's captured slow queries up by query pattern and delivers
 * a ranked report — top offenders by frequency and average duration — to the
 * team over email and/or Slack, so performance regressions surface proactively
 * instead of via ad-hoc complaints.
 *
 * Aggregation and rendering are pure functions so the ranking can be tested
 * without a database or an SMTP server.
 */

import { getBrandedHtml, sendEmail } from "../services/email.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import type { SlowQueryRecord, SlowQueryStore } from "../services/slowQueryLog.js";

/** How to order the ranked patterns. */
export type SlowQueryRankBy = "frequency" | "duration";

/** One query pattern rolled up over the digest window. */
export interface SlowQueryPattern {
  fingerprint: string;
  query: string;
  model: string | null;
  operation: string | null;
  count: number;
  totalDurationMs: number;
  averageDurationMs: number;
  maxDurationMs: number;
  minDurationMs: number;
  lastOccurredAt: Date;
}

export interface SlowQueryDigestData {
  windowStart: Date;
  windowEnd: Date;
  totalSlowQueries: number;
  patterns: SlowQueryPattern[];
}

export interface AggregateSlowQueriesOptions {
  since?: Date;
  until?: Date;
  /** Maximum number of patterns to return. Defaults to 10. */
  topN?: number;
  /** Primary ranking key. Defaults to `frequency`. */
  rankBy?: SlowQueryRankBy;
}

/**
 * Groups slow-query records by fingerprint and ranks the resulting patterns.
 *
 * Ranking is deterministic: the primary key is either call frequency or mean
 * duration, and the other is always the tie-breaker — so two patterns with the
 * same frequency are still ordered by how slow they are, and vice versa.
 */
export function aggregateSlowQueries(
  records: readonly SlowQueryRecord[],
  options: AggregateSlowQueriesOptions = {}
): SlowQueryDigestData {
  const { since, until, topN = 10, rankBy = "frequency" } = options;

  const windowStart = since ?? new Date(0);
  const windowEnd = until ?? new Date();

  const inWindow = records.filter(
    (record) =>
      record.occurredAt >= windowStart && record.occurredAt <= windowEnd
  );

  const groups = new Map<
    string,
    {
      fingerprint: string;
      query: string;
      model: string | null;
      operation: string | null;
      count: number;
      totalDurationMs: number;
      maxDurationMs: number;
      minDurationMs: number;
      lastOccurredAt: Date;
    }
  >();

  for (const record of inWindow) {
    const existing = groups.get(record.fingerprint);
    if (existing) {
      existing.count += 1;
      existing.totalDurationMs += record.durationMs;
      existing.maxDurationMs = Math.max(existing.maxDurationMs, record.durationMs);
      existing.minDurationMs = Math.min(existing.minDurationMs, record.durationMs);
      if (record.occurredAt > existing.lastOccurredAt) {
        existing.lastOccurredAt = record.occurredAt;
      }
    } else {
      groups.set(record.fingerprint, {
        fingerprint: record.fingerprint,
        query: record.query,
        model: record.model,
        operation: record.operation,
        count: 1,
        totalDurationMs: record.durationMs,
        maxDurationMs: record.durationMs,
        minDurationMs: record.durationMs,
        lastOccurredAt: record.occurredAt,
      });
    }
  }

  const patterns: SlowQueryPattern[] = Array.from(groups.values()).map((group) => ({
    fingerprint: group.fingerprint,
    query: group.query,
    model: group.model,
    operation: group.operation,
    count: group.count,
    totalDurationMs: group.totalDurationMs,
    averageDurationMs: group.totalDurationMs / group.count,
    maxDurationMs: group.maxDurationMs,
    minDurationMs: group.minDurationMs,
    lastOccurredAt: group.lastOccurredAt,
  }));

  patterns.sort((a, b) => {
    const primary =
      rankBy === "duration"
        ? b.averageDurationMs - a.averageDurationMs
        : b.count - a.count;
    if (primary !== 0) return primary;
    const secondary =
      rankBy === "duration"
        ? b.count - a.count
        : b.averageDurationMs - a.averageDurationMs;
    if (secondary !== 0) return secondary;
    // Final stable tie-breaker so ordering never depends on Map insertion.
    return a.fingerprint.localeCompare(b.fingerprint);
  });

  return {
    windowStart,
    windowEnd,
    totalSlowQueries: inWindow.length,
    patterns: patterns.slice(0, Math.max(0, topN)),
  };
}

function formatMs(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renders the ranked digest as a branded HTML email. */
export function buildSlowQueryDigestHtml(data: SlowQueryDigestData): string {
  const rows = data.patterns
    .map(
      (pattern, index) => `
      <tr>
        <td class="details-label">#${index + 1}</td>
        <td class="details-value">
          <code>${escapeHtml(pattern.query)}</code>
        </td>
        <td class="details-value">${escapeHtml(pattern.model ?? "—")}</td>
        <td class="details-value"><strong>${pattern.count}</strong></td>
        <td class="details-value">${formatMs(pattern.averageDurationMs)} ms</td>
        <td class="details-value">${formatMs(pattern.maxDurationMs)} ms</td>
      </tr>`
    )
    .join("\n");

  const windowLabel = `${data.windowStart.toUTCString()} → ${data.windowEnd.toUTCString()}`;

  const body = `
    <h2>Weekly Slow Query Digest</h2>
    <p><strong>${data.totalSlowQueries}</strong> slow ${data.totalSlowQueries === 1 ? "query" : "queries"} across
    <strong>${data.patterns.length}</strong> ${data.patterns.length === 1 ? "pattern" : "patterns"}.</p>
    <p style="color:#64748b;font-size:12px;">Window: ${windowLabel}</p>
    <table class="details-table">
      <tr>
        <td class="details-label"><strong>Rank</strong></td>
        <td class="details-value"><strong>Query pattern</strong></td>
        <td class="details-value"><strong>Model</strong></td>
        <td class="details-value"><strong>Frequency</strong></td>
        <td class="details-value"><strong>Avg duration</strong></td>
        <td class="details-value"><strong>Max duration</strong></td>
      </tr>
      ${rows || `<tr><td colspan="6" class="details-value">No slow queries in this window.</td></tr>`}
    </table>
    <p style="margin-top:24px;">Patterns are grouped by normalized query fingerprint. Investigate the
    highest-ranked entries first — they combine the most calls with the longest average duration.</p>
  `;

  return getBrandedHtml("RemitMortgage — Weekly Slow Query Digest", body);
}

/** Renders a compact Slack message for the same ranked data. */
export function buildSlowQueryDigestSlackText(data: SlowQueryDigestData): string {
  const lines = data.patterns.map(
    (pattern, index) =>
      `${index + 1}. \`${pattern.query}\` — ${pattern.count}x, avg ${formatMs(
        pattern.averageDurationMs
      )}ms, max ${formatMs(pattern.maxDurationMs)}ms`
  );

  return [
    `:snail: *Weekly Slow Query Digest*`,
    `${data.totalSlowQueries} slow queries across ${data.patterns.length} patterns.`,
    ...(lines.length > 0 ? lines : ["No slow queries in this window."]),
  ].join("\n");
}

/** Parses `SLOW_QUERY_DIGEST_RECIPIENTS` (comma-separated) into a list. */
export function getConfiguredRecipients(): string[] {
  return (process.env.SLOW_QUERY_DIGEST_RECIPIENTS || "")
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}

async function postSlackDigest(text: string): Promise<boolean> {
  const config = loadConfig();
  const webhookUrl = config.opsSlackWebhookUrl || config.alertWebhookUrl;
  if (!webhookUrl) {
    logger.info("[slow-query-digest] Slack webhook not configured, skipping Slack delivery");
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      logger.warn("[slow-query-digest] Slack webhook returned non-2xx", {
        status: response.status,
      });
      return false;
    }
    return true;
  } catch (error) {
    logger.error("[slow-query-digest] Failed to post Slack digest", { error });
    return false;
  }
}

export interface SlowQueryDigestResult {
  patterns: number;
  sent: number;
  failed: number;
  slackSent: boolean;
}

export interface SlowQueryDigestOptions {
  /** Store to read the window from. Ignored when `records` is provided. */
  store?: SlowQueryStore;
  /** Pre-fetched records; mainly for tests. */
  records?: readonly SlowQueryRecord[];
  recipients?: string[];
  /** Digest window length in days. Defaults to 7. */
  windowDays?: number;
  topN?: number;
  rankBy?: SlowQueryRankBy;
  now?: () => Date;
  /** Injectable email sender; defaults to the SMTP service. */
  send?: (to: string, subject: string, html: string) => Promise<boolean>;
  /** Injectable Slack sender; defaults to the configured webhook. */
  sendSlack?: (text: string) => Promise<boolean>;
}

/**
 * Builds and dispatches the weekly digest. Exported for the scheduler, tests,
 * and an admin trigger.
 */
export async function runSlowQueryDigestJob(
  options: SlowQueryDigestOptions = {}
): Promise<SlowQueryDigestResult> {
  const now = options.now ?? (() => new Date());
  const windowEnd = now();
  const windowStart = new Date(
    windowEnd.getTime() - (options.windowDays ?? 7) * 24 * 60 * 60 * 1000
  );

  const recipients = options.recipients ?? getConfiguredRecipients();
  const send = options.send ?? sendEmail;

  let records: readonly SlowQueryRecord[] = options.records ?? [];
  if (!options.records) {
    if (!options.store) {
      logger.warn("[slow-query-digest] No store configured, nothing to digest");
    } else {
      records = await options.store.findSince(windowStart, windowEnd);
    }
  }

  const data = aggregateSlowQueries(records, {
    since: windowStart,
    until: windowEnd,
    topN: options.topN,
    rankBy: options.rankBy,
  });

  if (data.patterns.length === 0) {
    logger.info("[slow-query-digest] No slow queries in window, skipping digest");
    return { patterns: 0, sent: 0, failed: 0, slackSent: false };
  }

  const html = buildSlowQueryDigestHtml(data);
  const subject = `RemitMortgage — Weekly Slow Query Digest (${data.patterns.length} patterns)`;

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const ok = await send(recipient, subject, html);
    if (ok) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  const sendSlack = options.sendSlack ?? postSlackDigest;
  const slackSent = await sendSlack(buildSlowQueryDigestSlackText(data));

  logger.info(
    `[slow-query-digest] Dispatched: ${sent} sent, ${failed} failed of ${recipients.length} recipients; Slack ${slackSent ? "sent" : "skipped"}`
  );

  return { patterns: data.patterns.length, sent, failed, slackSent };
}
