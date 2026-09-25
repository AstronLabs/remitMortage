// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import { Worker, WorkerOptions } from "bullmq";
import { getClusterClient } from "../services/redisCluster.js";
import { WebhookJobData } from "../services/queueService.js";
import { decrypt } from "../utils/crypto.js";
import { signPayload } from "../services/webhook.js";
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
  concurrency: 20,
  lockDuration: 30000,
  maxStalledCount: 3,
  stalledInterval: 30000,
};

const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BODY_BYTES = 2_048;
const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

let worker: Worker<WebhookJobData> | null = null;

async function attemptPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ statusCode: number; responseBody: string; error?: never } | { error: string; statusCode?: number; responseBody?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
      signal: controller.signal,
    });

    const raw = await res.text();
    const responseBody = raw.slice(0, MAX_RESPONSE_BODY_BYTES);
    return { statusCode: res.status, responseBody };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

export async function startWebhookWorker(): Promise<void> {
  if (worker) return;

  worker = new Worker<WebhookJobData>(
    "remitmortgage-webhooks",
    async (job) => {
      const { subscriptionId, url, encryptedSecret, topic, data } = job.data;
      const attempt = job.attemptsMade;

      logger.info("[webhook-worker] processing delivery", {
        subscriptionId,
        topic,
        attempt: attempt + 1,
      });

      const plaintextSecret = decrypt(encryptedSecret);
      const timestamp = String(Date.now());
      const deliveryId = crypto.randomUUID();

      const payload = {
        deliveryId,
        topic,
        timestamp: parseInt(timestamp, 10),
        data,
      };

      const body = JSON.stringify(payload);
      const signature = signPayload(plaintextSecret, timestamp, body);

      const headers: Record<string, string> = {
        "X-Webhook-Id": deliveryId,
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Topic": topic,
        "X-Webhook-Signature": signature,
      };

      const result = await attemptPost(url, headers, body);

      const success =
        "statusCode" in result &&
        result.statusCode !== undefined &&
        result.statusCode >= 200 &&
        result.statusCode < 300;

      await prisma.webhookDelivery.create({
        data: {
          id: deliveryId,
          subscriptionId,
          topic,
          payload: payload as any,
          statusCode: "statusCode" in result ? (result.statusCode ?? null) : null,
          responseBody:
            "responseBody" in result ? (result.responseBody ?? null) : null,
          error: "error" in result ? result.error : null,
          success,
          attempt,
          nextRetryAt: null,
        },
      });

      if (success) {
        logger.info("[webhook-worker] delivered", {
          subscriptionId,
          deliveryId,
          topic,
          attempt: attempt + 1,
          statusCode: (result as any).statusCode,
        });
        return { success: true, deliveryId };
      }

      const errorMsg =
        "error" in result
          ? result.error
          : `HTTP ${(result as any).statusCode}`;

      logger.warn("[webhook-worker] delivery failed", {
        subscriptionId,
        deliveryId,
        topic,
        attempt: attempt + 1,
        error: errorMsg,
      });

      if (job.attemptsMade >= (job.opts?.attempts || 5) - 1) {
        // last attempt - write to DLQ
        await prisma.webhookDLQ.create({
          data: {
            url,
            payload: payload as any,
            statusCode:
              "statusCode" in result ? (result.statusCode ?? null) : null,
            responsePayload:
              "responseBody" in result ? (result.responseBody ?? null) : null,
            error: errorMsg,
          },
        });
        logger.error("[webhook-worker] delivery permanently failed, added to DLQ", {
          subscriptionId,
          topic,
          url,
        });
      }

      throw new Error(errorMsg);
    },
    {
      ...workerOptions,
      // Let BullMQ handle backoff via job options instead of custom delay
    }
  );

  worker.on("completed", (job) => {
    logger.info("[webhook-worker] job completed", {
      subscriptionId: job.data.subscriptionId,
      deliveryId: job.id,
    });
  });

  worker.on("failed", (job, err) => {
    if (job) {
      logger.error("[webhook-worker] job failed after all retries", {
        subscriptionId: job.data.subscriptionId,
        error: err.message,
        attempts: job.attemptsMade + 1,
      });
    }
  });

  worker.on("error", (err) => {
    logger.error("[webhook-worker] worker error", { error: err.message });
  });

  await worker.waitUntilReady();
  logger.info("[webhook-worker] started");
}

export async function stopWebhookWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
  logger.info("[webhook-worker] stopped");
}

export function getWebhookWorker(): Worker<WebhookJobData> | null {
  return worker;
}
