// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Webhook delivery latency SLA monitoring (issue #619).
 *
 * Every delivery attempt records `dispatchedAt` (when the event was first
 * dispatched, shared by all attempts of that dispatch), `completedAt` and an
 * `outcome` of "success", "retry" or "dlq". Latency for a delivered event is
 * `completedAt - dispatchedAt` of its successful attempt, so time spent in
 * retries counts against the subscriber's SLA.
 *
 * An endpoint is flagged when its p95 latency exceeds the SLA threshold, or
 * when it has deliveries in the DLQ and none that succeeded in the window.
 */

import { prisma } from "./db.js";

export type DeliveryOutcome = "success" | "retry" | "dlq";

export interface DeliveryAttemptRecord {
  subscriptionId: string;
  url: string;
  label: string;
  outcome: DeliveryOutcome | string | null;
  dispatchedAt: Date | null;
  completedAt: Date | null;
}

export interface EndpointLatency {
  subscriptionId: string;
  url: string;
  label: string;
  delivered: number;
  retries: number;
  deadLettered: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  slaBreached: boolean;
  breachReason: "p95_over_sla" | "dlq_without_success" | null;
}

export interface LatencyReport {
  generatedAt: string;
  windowMinutes: number;
  slaMs: number;
  breachedCount: number;
  endpoints: EndpointLatency[];
}

export const DEFAULT_LATENCY_WINDOW_MINUTES = 60;
export const DEFAULT_LATENCY_SLA_MS = 5_000;
export const MAX_LATENCY_WINDOW_MINUTES = 7 * 24 * 60;

/** Nearest-rank percentile of an ascending-sorted list. Returns null when empty. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(Math.max(rank, 1), sortedAsc.length) - 1];
}

/** Rolls delivery attempts up into per-endpoint percentiles and SLA flags. */
export function buildLatencyReport(
  attempts: DeliveryAttemptRecord[],
  options: { windowMinutes: number; slaMs: number; now?: Date }
): LatencyReport {
  const groups = new Map<string, { url: string; label: string; latencies: number[]; retries: number; dlq: number }>();

  for (const a of attempts) {
    let g = groups.get(a.subscriptionId);
    if (!g) {
      g = { url: a.url, label: a.label, latencies: [], retries: 0, dlq: 0 };
      groups.set(a.subscriptionId, g);
    }
    if (a.outcome === "retry") g.retries++;
    else if (a.outcome === "dlq") g.dlq++;
    else if (a.outcome === "success" && a.dispatchedAt && a.completedAt) {
      g.latencies.push(Math.max(0, a.completedAt.getTime() - a.dispatchedAt.getTime()));
    }
  }

  const endpoints: EndpointLatency[] = [];
  for (const [subscriptionId, g] of groups) {
    const sorted = [...g.latencies].sort((x, y) => x - y);
    const p95Ms = percentile(sorted, 95);

    let breachReason: EndpointLatency["breachReason"] = null;
    if (p95Ms !== null && p95Ms > options.slaMs) breachReason = "p95_over_sla";
    else if (sorted.length === 0 && g.dlq > 0) breachReason = "dlq_without_success";

    endpoints.push({
      subscriptionId,
      url: g.url,
      label: g.label,
      delivered: sorted.length,
      retries: g.retries,
      deadLettered: g.dlq,
      p50Ms: percentile(sorted, 50),
      p95Ms,
      p99Ms: percentile(sorted, 99),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      slaBreached: breachReason !== null,
      breachReason,
    });
  }

  // Breached endpoints first, then worst p95.
  endpoints.sort(
    (a, b) => Number(b.slaBreached) - Number(a.slaBreached) || (b.p95Ms ?? -1) - (a.p95Ms ?? -1)
  );

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    windowMinutes: options.windowMinutes,
    slaMs: options.slaMs,
    breachedCount: endpoints.filter((e) => e.slaBreached).length,
    endpoints,
  };
}

/** Loads attempts completed inside the rolling window and builds the report. */
export async function getWebhookLatencyReport(options: {
  windowMinutes: number;
  slaMs: number;
  now?: Date;
}): Promise<LatencyReport> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.windowMinutes * 60_000);

  const rows = await prisma.webhookDelivery.findMany({
    where: { completedAt: { gte: since, lte: now } },
    select: {
      subscriptionId: true,
      outcome: true,
      dispatchedAt: true,
      completedAt: true,
      subscription: { select: { url: true, label: true } },
    },
  });

  const attempts: DeliveryAttemptRecord[] = rows.map((r: any) => ({
    subscriptionId: r.subscriptionId,
    url: r.subscription?.url ?? "",
    label: r.subscription?.label ?? "",
    outcome: r.outcome,
    dispatchedAt: r.dispatchedAt,
    completedAt: r.completedAt,
  }));

  return buildLatencyReport(attempts, { ...options, now });
}
