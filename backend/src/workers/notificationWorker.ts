// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Worker, WorkerOptions } from "bullmq";
import { Queue } from "bullmq";
import { getClusterClient } from "../services/redisCluster.js";
import { NotificationJobData } from "../services/queueService.js";
import { sendEmail, sendDepositReceipt, sendRepaymentReminder, sendLoanStatusUpdate } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";
import { prisma } from "../services/db.js";
import logger from "../utils/logger.js";

function buildConnection(): WorkerOptions["connection"] {
  const client = getClusterClient();
  if (!client) {
    return { host: "localhost", port: 6379 };
  }
  return client;
}

const workerOptions: WorkerOptions = {
  connection: buildConnection(),
  concurrency: 10,
  lockDuration: 30000,
  maxStalledCount: 3,
  stalledInterval: 30000,
};

let worker: Worker<NotificationJobData> | null = null;

async function handleEmailDispatch(recipient: string, content: string): Promise<boolean> {
  if (content.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.template === "deposit_receipt") {
        return await sendDepositReceipt(recipient, parsed.amount, parsed.transactionId);
      }
      if (parsed.template === "repayment_reminder") {
        return await sendRepaymentReminder(recipient, parsed.amount, parsed.dueDate);
      }
      if (parsed.template === "loan_status_update") {
        return await sendLoanStatusUpdate(recipient, parsed.loanId, parsed.status);
      }
    } catch {
      // fallback below
    }
  }
  return await sendEmail(recipient, "Notification Alert - RemitMortgage", content);
}

async function handleWebhookDispatch(recipient: string, content: string): Promise<boolean> {
  let payload = {};
  try {
    payload = JSON.parse(content);
  } catch {
    payload = { message: content };
  }
  const result = await sendWebhook(recipient, payload);
  return result.success;
}

export async function startNotificationWorker(): Promise<void> {
  if (worker) return;

  worker = new Worker<NotificationJobData>(
    "remitmortgage-notifications",
    async (job) => {
      const { notificationId, recipient, type, content } = job.data;

      logger.info("[notification-worker] processing notification", {
        notificationId,
        type,
        attempt: job.attemptsMade + 1,
      });

      let success = false;
      try {
        if (type === "EMAIL") {
          success = await handleEmailDispatch(recipient, content);
        } else if (type === "WEBHOOK") {
          success = await handleWebhookDispatch(recipient, content);
        }

        if (success) {
          await prisma.notification.update({
            where: { id: notificationId },
            data: {
              status: "Sent",
              attempts: job.attemptsMade + 1,
              lastError: null,
              nextRetryAt: null,
            },
          });

          logger.info("[notification-worker] notification sent", { notificationId });
          return { success: true, notificationId };
        }

        const error = `${type} dispatch returned false`;
        await prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: "Failed",
            attempts: job.attemptsMade + 1,
            lastError: error,
          },
        });

        throw new Error(error);
      } catch (err: any) {
        const errorMsg = err.message || String(err);

        await prisma.notification.update({
          where: { id: notificationId },
          data: {
            status: "Failed",
            attempts: job.attemptsMade + 1,
            lastError: errorMsg,
          },
        });

        logger.warn("[notification-worker] notification failed", {
          notificationId,
          error: errorMsg,
          attempt: job.attemptsMade + 1,
        });

        throw err;
      }
    },
    workerOptions
  );

  worker.on("completed", (job) => {
    logger.info("[notification-worker] job completed", {
      notificationId: job.data.notificationId,
      jobId: job.id,
    });
  });

  worker.on("failed", (job, err) => {
    if (job) {
      logger.error("[notification-worker] job failed after all retries", {
        notificationId: job.data.notificationId,
        error: err.message,
        attempts: job.attemptsMade + 1,
      });
    }
  });

  worker.on("error", (err) => {
    logger.error("[notification-worker] worker error", { error: err.message });
  });

  await worker.waitUntilReady();
  logger.info("[notification-worker] started");
}

export async function stopNotificationWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
  logger.info("[notification-worker] stopped");
}

export function getNotificationWorker(): Worker<NotificationJobData> | null {
  return worker;
}
