// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import cron from "node-cron";
import {
  rotateDueSecrets,
  pruneExpiredPreviousSecrets,
  ROTATION_INTERVAL_DAYS,
  ROTATION_GRACE_PERIOD_DAYS,
} from "../services/webhook.js";
import { queueNotification } from "../services/notification.js";
import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

/**
 * Webhook Signing Key Auto-Rotation Scheduler
 *
 * Every day, sweeps webhook subscriptions for keys older than
 * {@link ROTATION_INTERVAL_DAYS} and rotates them, then prunes any
 * previous key whose post-rotation grace period has elapsed.
 *
 * Schedule can be customized via WEBHOOK_KEY_ROTATION_CRON_SCHEDULE.
 */
let rotationTask: ReturnType<typeof cron.schedule> | null = null;

export function startWebhookKeyRotationScheduler(): void {
  if (rotationTask) {
    logger.info("[webhook-rotation] scheduler already running, ignoring start request");
    return;
  }

  const schedule = process.env.WEBHOOK_KEY_ROTATION_CRON_SCHEDULE || "0 3 * * *";

  rotationTask = cron.schedule(
    schedule,
    () => {
      void runWebhookKeyRotationSweep();
    },
    { timezone: "UTC" }
  );

  logger.info("[webhook-rotation] scheduler started", { schedule, rotationIntervalDays: ROTATION_INTERVAL_DAYS });
}

export function stopWebhookKeyRotationScheduler(): void {
  if (rotationTask) {
    rotationTask.stop();
    rotationTask = null;
    logger.info("[webhook-rotation] scheduler stopped");
  }
}

/**
 * Runs one rotation sweep: rotates due signing keys, notifies an operator so
 * the new secret can be retrieved and delivered to the subscriber, then
 * prunes previous keys past their grace period. Exported so it can also be
 * triggered manually (tests, admin tooling) without waiting for the cron tick.
 */
export async function runWebhookKeyRotationSweep(): Promise<{ rotated: number; pruned: number }> {
  const { rotatedIds, secrets } = await rotateDueSecrets();

  if (rotatedIds.length > 0) {
    const config = loadConfig();
    if (config.webhookRotationNotifyEmail) {
      const subs = await prisma.webhookSubscription.findMany({
        where: { id: { in: rotatedIds } },
        select: { id: true, label: true },
      });
      for (const sub of subs) {
        try {
          // The freshly-generated secret is delivered here because it is
          // never persisted in plaintext — this notification is the only
          // chance to hand it off for an unattended (scheduled) rotation.
          await queueNotification(
            config.webhookRotationNotifyEmail,
            "EMAIL",
            `Webhook signing key auto-rotated for subscription "${sub.label}" (${sub.id}). ` +
              `New secret: ${secrets[sub.id]}. Deliver it to the subscriber before the previous ` +
              `key's ${ROTATION_GRACE_PERIOD_DAYS}-day grace period ends.`
          );
        } catch (err) {
          logger.error("[webhook-rotation] failed to queue rotation notification", {
            subscriptionId: sub.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const pruned = await pruneExpiredPreviousSecrets();

  logger.info("[webhook-rotation] sweep complete", {
    rotated: rotatedIds.length,
    pruned,
  });

  return { rotated: rotatedIds.length, pruned };
}
