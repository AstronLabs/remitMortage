// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Service-level timers for loan review stages (issue #1047).
 *
 * Every application transition is timed: a row is opened in
 * `LoanReviewStageTimer` when the application enters a stage and closed when it
 * leaves. Three things are built on top of those intervals:
 *
 *   - {@link summarizeStageDurations} turns a set of intervals into per-stage
 *     average and worst-case durations for a selectable period,
 *   - {@link getStageDurationSummary} loads the intervals for a period,
 *   - {@link runStuckStageAlertScan} alerts (exactly once per interval) when an
 *     application has sat in a stage past the configured threshold.
 *
 * The writer side ({@link recordStageEnter} / {@link transitionReviewStage}) is
 * called from the loan store and the auto-rejection engine on every status
 * change, mirroring how `loanHistory` records the audit trail.
 */

import { prisma } from "./db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { sendEmail } from "./email.js";
import { sendWebhook } from "./webhook.js";

/** Review stages an application passes through, in the order they occur. */
export const REVIEW_STAGES = [
  "Pending",
  "Approved",
  "Rejected",
  "Disbursing",
  "Repaying",
  "Completed",
  "Withdrawn",
] as const;

export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** Fallback threshold when the config value is absent or unusable. */
export const DEFAULT_REVIEW_STAGE_STUCK_THRESHOLD_HOURS = 72;
/** Default look-back for the duration summary when no period is supplied. */
export const DEFAULT_STAGE_SUMMARY_WINDOW_DAYS = 30;

const MS_PER_HOUR = 3_600_000;

/**
 * The slice of the Prisma client this module touches. Declared structurally,
 * and accessed through {@link timerDelegate}, so it works both against the
 * generated client and against a `$transaction` handle in tests.
 */
interface StageTimerClient {
  loanReviewStageTimer: {
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
    findMany: (args?: Record<string, unknown>) => Promise<any[]>;
  };
}

/**
 * The generated client predates this model, so it is reached through a cast
 * (the same pattern used elsewhere, e.g. `feeWaiver.ts`). A migration ships
 * the table and the client is regenerated on install.
 */
function timerDelegate(client?: unknown): StageTimerClient["loanReviewStageTimer"] {
  return (client ?? prisma as any).loanReviewStageTimer;
}

// ── Writer side ─────────────────────────────────────────────────────────────

/** Open a stage interval for an application. */
export async function recordStageEnter(
  client: unknown,
  applicationId: string,
  stage: string,
  enteredAt: Date
): Promise<void> {
  await timerDelegate(client).create({
    data: { applicationId, stage, enteredAt },
  });
}

/**
 * Close the application's currently-open stage interval and open a new one for
 * `toStage`. Callers only invoke this when a status genuinely changed, so the
 * close and the open line up with the transition timestamp.
 */
export async function transitionReviewStage(
  client: unknown,
  applicationId: string,
  toStage: string,
  at: Date
): Promise<void> {
  const delegate = timerDelegate(client);
  await delegate.updateMany({
    where: { applicationId, leftAt: null },
    data: { leftAt: at },
  });
  await delegate.create({
    data: { applicationId, stage: toStage, enteredAt: at },
  });
}

// ── Duration summary ────────────────────────────────────────────────────────

export interface StageInterval {
  stage: string;
  enteredAt: Date;
  leftAt: Date | null;
}

export interface StageDurationSummary {
  stage: string;
  /** Intervals that have both ends and therefore a measured duration. */
  completedCount: number;
  /** Intervals still open at generation time (no duration yet). */
  openCount: number;
  /** Mean of the completed durations, rounded to the nearest millisecond. */
  averageMs: number | null;
  /** Longest completed duration. */
  worstCaseMs: number | null;
}

export interface StageDurationReport {
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  stages: StageDurationSummary[];
}

/**
 * Roll a set of stage intervals up into per-stage average / worst-case
 * durations. Only intervals that *entered* inside the period count; durations
 * come from completed intervals, while still-open ones are reported separately
 * so an all-in-flight stage is not falsely shown as instantaneous.
 */
export function summarizeStageDurations(
  intervals: StageInterval[],
  options: { periodStart: Date; periodEnd: Date; now?: Date }
): StageDurationReport {
  const buckets = new Map<string, { durations: number[]; open: number }>();
  for (const stage of REVIEW_STAGES) buckets.set(stage, { durations: [], open: 0 });

  const startMs = options.periodStart.getTime();
  const endMs = options.periodEnd.getTime();

  for (const interval of intervals) {
    const enteredMs = interval.enteredAt.getTime();
    if (enteredMs < startMs || enteredMs > endMs) continue;

    let bucket = buckets.get(interval.stage);
    if (!bucket) {
      bucket = { durations: [], open: 0 };
      buckets.set(interval.stage, bucket);
    }

    if (interval.leftAt) {
      bucket.durations.push(Math.max(0, interval.leftAt.getTime() - enteredMs));
    } else {
      bucket.open += 1;
    }
  }

  const stages: StageDurationSummary[] = [...buckets.entries()].map(([stage, bucket]) => {
    const { durations } = bucket;
    const averageMs = durations.length
      ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length)
      : null;
    return {
      stage,
      completedCount: durations.length,
      openCount: bucket.open,
      averageMs,
      worstCaseMs: durations.length ? Math.max(...durations) : null,
    };
  });

  return {
    generatedAt: (options.now ?? new Date()).toISOString(),
    periodStart: options.periodStart.toISOString(),
    periodEnd: options.periodEnd.toISOString(),
    stages,
  };
}

/** Load the intervals that entered during the period and summarise them. */
export async function getStageDurationSummary(options: {
  periodStart: Date;
  periodEnd: Date;
  now?: Date;
  client?: unknown;
}): Promise<StageDurationReport> {
  const rows = await timerDelegate(options.client).findMany({
    where: { enteredAt: { gte: options.periodStart, lte: options.periodEnd } },
    select: { stage: true, enteredAt: true, leftAt: true },
  });

  const intervals: StageInterval[] = rows.map((row) => ({
    stage: row.stage,
    enteredAt: row.enteredAt,
    leftAt: row.leftAt ?? null,
  }));

  return summarizeStageDurations(intervals, options);
}

// ── Stuck-application alerts ────────────────────────────────────────────────

export interface StuckStageAlert {
  applicationId: string;
  stage: string;
  enteredAt: string;
  elapsedHours: number;
  thresholdHours: number;
}

export interface StuckStageScanResult {
  scannedCount: number;
  alertedCount: number;
  thresholdHours: number;
  alerts: StuckStageAlert[];
}

/** Resolve the alert threshold, ignoring a non-positive override. */
function resolveThresholdHours(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
  const configured = loadConfig().reviewStageStuckThresholdHours;
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_REVIEW_STAGE_STUCK_THRESHOLD_HOURS;
}

/** Default delivery: ops email (and the assigned reviewer, when set) + Slack. */
function defaultStuckStageAlertSender(): (alert: StuckStageAlert) => Promise<void> {
  return async (alert) => {
    const config = loadConfig();
    const subject = `⚠️ [Stage Timer Alert] Loan ${alert.applicationId} stuck in ${alert.stage}`;
    const html = `
      <h2>Review Stage Threshold Exceeded</h2>
      <p><strong>Application:</strong> ${alert.applicationId}</p>
      <p><strong>Stage:</strong> ${alert.stage}</p>
      <p><strong>Entered:</strong> ${alert.enteredAt}</p>
      <p><strong>Time in stage:</strong> ${alert.elapsedHours.toFixed(1)} hours (threshold: ${alert.thresholdHours}h)</p>
    `;

    if (config.opsFallbackAlertEmail) {
      await sendEmail(config.opsFallbackAlertEmail, subject, html);
    }
    if (config.opsSlackWebhookUrl) {
      await sendWebhook(config.opsSlackWebhookUrl, { text: `${subject} — ${alert.elapsedHours.toFixed(1)}h in stage` });
    }
  };
}

/**
 * Alert on every open interval that has exceeded the threshold, then stamp it
 * so it is never alerted again.
 *
 * Exactly-once is enforced by an atomic claim (`updateMany` guarded on
 * `alertSentAt: null`): when two scans overlap only the winning one delivers.
 * A delivery failure releases the claim so a later scan retries, rather than
 * silently dropping the alert.
 */
export async function runStuckStageAlertScan(options: {
  now?: Date;
  thresholdHours?: number;
  client?: unknown;
  sendAlert?: (alert: StuckStageAlert) => Promise<void>;
} = {}): Promise<StuckStageScanResult> {
  const now = options.now ?? new Date();
  const thresholdHours = resolveThresholdHours(options.thresholdHours);
  const thresholdMs = thresholdHours * MS_PER_HOUR;
  const delegate = timerDelegate(options.client);
  const deliver = options.sendAlert ?? defaultStuckStageAlertSender();

  const open = await delegate.findMany({ where: { leftAt: null, alertSentAt: null } });

  const alerts: StuckStageAlert[] = [];
  for (const row of open) {
    const enteredAt = new Date(row.enteredAt);
    const elapsedMs = now.getTime() - enteredAt.getTime();
    if (elapsedMs < thresholdMs) continue;

    // Claim the interval before delivering, so an overlapping scan can't also fire.
    const claimed = await delegate.updateMany({
      where: { id: row.id, alertSentAt: null },
      data: { alertSentAt: now },
    });
    if (claimed.count === 0) continue;

    const alert: StuckStageAlert = {
      applicationId: row.applicationId,
      stage: row.stage,
      enteredAt: enteredAt.toISOString(),
      elapsedHours: elapsedMs / MS_PER_HOUR,
      thresholdHours,
    };

    try {
      await deliver(alert);
      alerts.push(alert);
    } catch (error) {
      logger.error("[ReviewStage] Failed to deliver stuck-stage alert", { error, alert });
      // Release the claim so the next scan retries the delivery.
      await delegate.updateMany({ where: { id: row.id, alertSentAt: now }, data: { alertSentAt: null } });
    }
  }

  if (alerts.length > 0) {
    logger.warn(`[ReviewStage] ${alerts.length} application(s) past the ${thresholdHours}h stage threshold`);
  }

  return { scannedCount: open.length, alertedCount: alerts.length, thresholdHours, alerts };
}
