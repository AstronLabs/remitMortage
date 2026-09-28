// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import cron from "node-cron";
import { prisma } from "../services/db.js";
import { updateSubscriptionStatus } from "../services/webhook.js";
import { queueNotification } from "../services/notification.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

/**
 * Stale Webhook Subscriber Auto-Disable Scheduler
 *
 * The dead-letter-queue and per-delivery retry/backoff (services/webhook.ts,
 * workers/webhookWorker.ts) absorb transient failures, but say nothing about
 * a subscriber that never recovers — e.g. an integrator who shut down without
 * unsubscribing. Left alone, every future event keeps queuing a full
 * MAX_ATTEMPTS retry cycle against a dead endpoint indefinitely.
 *
 * Each dispatch's terminal outcome updates `consecutiveFailedDispatches` and
 * `failingSinceAt` on the subscription (see workers/webhookWorker.ts). This
 * sweep pauses (`status: "paused"`) any *active* subscription that has both:
 *
 *   - failed at least `webhookAutoDisableFailureThreshold` consecutive
 *     dispatch cycles (all attempts exhausted, no success in between), and
 *   - been failing continuously for at least `webhookAutoDisableStaleAfterMs`
 *     — so a subscriber that merely receives infrequent events, or that
 *     recovers between events, is never disabled just for hitting the count
 *     quickly.
 *
 * Pausing is the same reversible state the manual admin API uses
 * (`PATCH /subscriptions/:id/status`), so a subscriber can always be
 * re-enabled once the integrator fixes their endpoint — nothing is deleted.
 *
 * Schedule can be customized via WEBHOOK_AUTO_DISABLE_CRON_SCHEDULE.
 */
let autoDisableTask: ReturnType<typeof cron.schedule> | null = null;

export function startWebhookAutoDisableScheduler(): void {
  if (autoDisableTask) {
    logger.info("[webhook-auto-disable] scheduler already running, ignoring start request");
    return;
  }

  const schedule = process.env.WEBHOOK_AUTO_DISABLE_CRON_SCHEDULE || "0 */6 * * *";

  autoDisableTask = cron.schedule(
    schedule,
    () => {
      void runWebhookAutoDisableSweep();
    },
    { timezone: "UTC" }
  );

  logger.info("[webhook-auto-disable] scheduler started", { schedule });
}

export function stopWebhookAutoDisableScheduler(): void {
  if (autoDisableTask) {
    autoDisableTask.stop();
    autoDisableTask = null;
    logger.info("[webhook-auto-disable] scheduler stopped");
  }
}

/**
 * Runs one sweep: finds active subscriptions stuck in a long-running failure
 * streak, pauses them, and notifies an operator. Exported so it can also be
 * triggered manually (tests, admin tooling) without waiting for the cron tick.
 */
export async function runWebhookAutoDisableSweep(): Promise<{ disabledIds: string[] }> {
  const config = loadConfig();
  const cutoff = new Date(Date.now() - config.webhookAutoDisableStaleAfterMs);

  const stale = await prisma.webhookSubscription.findMany({
    where: {
      status: "active",
      consecutiveFailedDispatches: { gte: config.webhookAutoDisableFailureThreshold },
      failingSinceAt: { not: null, lte: cutoff },
    },
    select: { id: true, label: true, url: true, consecutiveFailedDispatches: true, failingSinceAt: true },
  });

  const disabledIds: string[] = [];

  for (const sub of stale) {
    await updateSubscriptionStatus(sub.id, "paused");
    await prisma.webhookSubscription.update({
      where: { id: sub.id },
      data: { autoDisabledAt: new Date() },
    });
    disabledIds.push(sub.id);

    logger.warn("[webhook-auto-disable] paused stale subscriber", {
      subscriptionId: sub.id,
      label: sub.label,
      url: sub.url,
      consecutiveFailedDispatches: sub.consecutiveFailedDispatches,
      failingSinceAt: sub.failingSinceAt,
    });

    if (config.webhookAutoDisableNotifyEmail) {
      try {
        await queueNotification(
          config.webhookAutoDisableNotifyEmail,
          "EMAIL",
          `Webhook subscriber "${sub.label}" (${sub.id}, ${sub.url}) was automatically paused ` +
            `after ${sub.consecutiveFailedDispatches} consecutive failed delivery cycles, ` +
            `failing continuously since ${sub.failingSinceAt?.toISOString()}. ` +
            `Re-enable it via PATCH /subscriptions/${sub.id}/status once the endpoint is fixed.`
        );
      } catch (err) {
        logger.error("[webhook-auto-disable] failed to queue notification", {
          subscriptionId: sub.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info("[webhook-auto-disable] sweep complete", { disabled: disabledIds.length });

  return { disabledIds };
}
