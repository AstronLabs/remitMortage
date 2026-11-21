// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Worker, type WorkerOptions } from "bullmq";
import { getClusterClient } from "../services/redisCluster.js";
import { processAnalyticsJob, type AnalyticsJobData } from "../services/analyticsEvents.js";
import logger from "../utils/logger.js";
import { attachDeadLetterQueue } from "../services/deadLetterQueue.js";
import {
  ActiveJobTracker,
  drainWorker,
  loadShutdownTimeouts,
  type WorkerDrainResult,
} from "../services/gracefulShutdown.js";

function connection(): WorkerOptions["connection"] {
  return getClusterClient() || { host: "localhost", port: 6379 };
}

let worker: Worker<AnalyticsJobData> | null = null;
// Jobs running right now, so a shutdown that outlasts its timeout can requeue them.
const activeJobs = new ActiveJobTracker();

export async function startAnalyticsWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker<AnalyticsJobData>("remitmortgage-analytics", activeJobs.wrap((job) => processAnalyticsJob(job.data)), {
    connection: connection(), concurrency: 10, lockDuration: 30000, maxStalledCount: 3,
  });
  worker.on("error", (error) => logger.error("[analytics-worker] worker error", { error }));
  // Capture jobs that exhaust their retries instead of dropping them (issue #1103).
  attachDeadLetterQueue("remitmortgage-analytics", worker);
  await worker.waitUntilReady();
  logger.info("[analytics-worker] started");
}

/**
 * Stops taking jobs and waits for running ones to finish; any still running at
 * `timeoutMs` are requeued (see drainWorker).
 */
export async function stopAnalyticsWorker(
  timeoutMs: number = loadShutdownTimeouts().jobTimeoutMs
): Promise<WorkerDrainResult | void> {
  if (!worker) return;
  const closing = worker;
  worker = null;
  const result = await drainWorker("analytics", closing, timeoutMs, activeJobs);
  logger.info("[analytics-worker] stopped", { forced: result.forced, requeued: result.requeued });
  return result;
}