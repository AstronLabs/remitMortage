import { Worker, type WorkerOptions } from "bullmq";
import { getClusterClient } from "../services/redisCluster.js";
import { processAnalyticsJob, type AnalyticsJobData } from "../services/analyticsEvents.js";
import logger from "../utils/logger.js";

function connection(): WorkerOptions["connection"] {
  return getClusterClient() || { host: "localhost", port: 6379 };
}

let worker: Worker<AnalyticsJobData> | null = null;

export async function startAnalyticsWorker(): Promise<void> {
  if (worker) return;
  worker = new Worker<AnalyticsJobData>("remitmortgage-analytics", (job) => processAnalyticsJob(job.data), {
    connection: connection(), concurrency: 10, lockDuration: 30000, maxStalledCount: 3,
  });
  worker.on("error", (error) => logger.error("[analytics-worker] worker error", { error }));
  await worker.waitUntilReady();
  logger.info("[analytics-worker] started");
}

export async function stopAnalyticsWorker(): Promise<void> {
  if (!worker) return;
  await worker.close();
  worker = null;
}