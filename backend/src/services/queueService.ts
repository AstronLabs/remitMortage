// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Queue, QueueOptions, Job, JobsOptions } from "bullmq";
import { getClusterClient, isClusterMode, getClusterStatus } from "./redisCluster.js";
import {
  FairQueueScheduler,
  JobPriorityClass,
  JobLane,
  JOB_LANES,
  JOB_LANE_CATALOG,
  LANE_PRIORITY,
  laneForNotificationType,
  laneForPriority,
  laneLabel,
  type StarvationReport,
  type WaitTimeStats,
} from "./queueFairness.js";
import {
  queueLaneAvgWaitSeconds,
  queueLaneDepth,
  queueLaneOldestWaitSeconds,
} from "./metrics.js";
import logger from "../utils/logger.js";

export type NotificationJobType = "EMAIL" | "WEBHOOK" | "SMS" | "PUSH";

export interface NotificationJobData {
  notificationId: string;
  recipient: string;
  type: NotificationJobType;
  content: string;
  /** Tenant whose branding the notification is sent with. */
  tenantId?: string;
}

export type WebhookJobTopic =
  | "deposit"
  | "withdraw"
  | "release"
  | "disburse"
  | "repay";

export interface WebhookJobData {
  subscriptionId: string;
  url: string;
  encryptedSecret: string;
  topic: WebhookJobTopic;
  data: {
    contractId: string;
    borrower: string;
    amount: string;
    ledger: number;
  };
  attempt: number;
  webhookSchemaVersion: number;
}

export interface EmailJobData {
  recipient: string;
  subject: string;
  content: string;
}

export interface AnalyticsJobData {
  events: Array<{
    id: string;
    event: string;
    userId: string;
    properties: Record<string, unknown>;
    timestamp: string;
  }>;
}

const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: {
    type: "exponential",
    delay: 1000,
  },
  removeOnComplete: 100,
  removeOnFail: 50,
};

/**
 * Fairness policy shared by the queues (issue #862): priority classes,
 * per-tenant concurrency caps, wait-time metrics and starvation detection.
 */
export const fairQueue = new FairQueueScheduler({
  perTenantCap: Number(process.env.QUEUE_PER_TENANT_CAP || 10),
  starvationThresholdMs: Number(process.env.QUEUE_STARVATION_THRESHOLD_MS || 30_000),
});

/** BullMQ options for a priority class (lower number = higher priority). */
export function priorityOptions(priority: JobPriorityClass): JobsOptions {
  return { priority };
}

/** BullMQ options for a public priority lane. Explicit caller priorities win. */
export function laneOptions(lane: JobLane, opts?: JobsOptions): JobsOptions {
  return { ...opts, priority: opts?.priority ?? LANE_PRIORITY[lane] };
}

export interface LaneStats {
  depth: number;
  oldestWaitMs: number;
  avgWaitMs: number;
}

export type LaneMetrics = Record<JobLane, LaneStats>;

export function emptyLaneMetrics(): LaneMetrics {
  return {
    [JobLane.HIGH]: { depth: 0, oldestWaitMs: 0, avgWaitMs: 0 },
    [JobLane.NORMAL]: { depth: 0, oldestWaitMs: 0, avgWaitMs: 0 },
    [JobLane.LOW]: { depth: 0, oldestWaitMs: 0, avgWaitMs: 0 },
  };
}

export interface FairnessMetrics {
  waitByPriority: Record<JobPriorityClass, WaitTimeStats>;
  waitingByPriority: Record<JobPriorityClass, number>;
  starvation: StarvationReport;
  lanes: LaneMetrics;
}

function buildConnection(): QueueOptions["connection"] {
  const client = getClusterClient();
  if (!client) {
    return { host: "localhost", port: 6379 };
  }
  return client;
}

function buildQueueOptions(): QueueOptions {
  return {
    connection: buildConnection(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  };
}

class QueueService {
  public readonly notificationQueue: Queue<NotificationJobData>;
  public readonly webhookQueue: Queue<WebhookJobData>;
  public readonly emailQueue: Queue<EmailJobData>;
  public readonly analyticsQueue: Queue<AnalyticsJobData>;

  private initialized = false;

  constructor() {
    this.notificationQueue = new Queue<NotificationJobData>(
      "remitmortgage-notifications",
      buildQueueOptions()
    );
    this.webhookQueue = new Queue<WebhookJobData>(
      "remitmortgage-webhooks",
      buildQueueOptions()
    );
    this.emailQueue = new Queue<EmailJobData>(
      "remitmortgage-emails",
      buildQueueOptions()
    );
    this.analyticsQueue = new Queue<AnalyticsJobData>(
      "remitmortgage-analytics",
      buildQueueOptions()
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const mode = isClusterMode() ? "cluster" : "single-node";
      const status = getClusterStatus();

      logger.info("[queue-service] initializing queues", {
        mode,
        connected: status.connected,
        nodeCount: status.nodeCount,
        queues: ["notifications", "webhooks", "emails"],
      });

      await this.notificationQueue.waitUntilReady();
      await this.webhookQueue.waitUntilReady();
      await this.emailQueue.waitUntilReady();
      await this.analyticsQueue.waitUntilReady();

      this.initialized = true;
      logger.info("[queue-service] all queues ready");
    } catch (error) {
      logger.error("[queue-service] failed to initialize queues", { error });
      throw error;
    }
  }

  async addAnalyticsJob(data: AnalyticsJobData, opts?: JobsOptions): Promise<Job<AnalyticsJobData> | undefined> {
    if (!this.initialized) return undefined;
    try {
      return await this.analyticsQueue.add(
        "persist-analytics",
        data,
        laneOptions(JOB_LANE_CATALOG["analytics.persist"], opts)
      );
    } catch (error) {
      logger.error("[queue-service] failed to add analytics job", { error, count: data.events.length });
      return undefined;
    }
  }

  async addNotificationJob(
    data: NotificationJobData,
    opts?: JobsOptions
  ): Promise<Job<NotificationJobData> | undefined> {
    if (!this.initialized) {
      logger.warn("[queue-service] notification queue not initialized, skipping job");
      return undefined;
    }
    try {
      return await this.notificationQueue.add(
        "send-notification",
        data,
        laneOptions(laneForNotificationType(data.type), opts)
      );
    } catch (error) {
      logger.error("[queue-service] failed to add notification job", { error, notificationId: data.notificationId });
      return undefined;
    }
  }

  async addWebhookJob(
    data: WebhookJobData,
    opts?: JobsOptions
  ): Promise<Job<WebhookJobData> | undefined> {
    if (!this.initialized) {
      logger.warn("[queue-service] webhook queue not initialized, skipping job");
      return undefined;
    }
    try {
      return await this.webhookQueue.add(
        "deliver-webhook",
        data,
        laneOptions(JOB_LANE_CATALOG["webhook.delivery"], opts)
      );
    } catch (error) {
      logger.error("[queue-service] failed to add webhook job", { error, subscriptionId: data.subscriptionId });
      return undefined;
    }
  }

  async addEmailJob(
    data: EmailJobData,
    opts?: JobsOptions
  ): Promise<Job<EmailJobData> | undefined> {
    if (!this.initialized) {
      logger.warn("[queue-service] email queue not initialized, skipping job");
      return undefined;
    }
    try {
      return await this.emailQueue.add(
        "send-email",
        data,
        laneOptions(JOB_LANE_CATALOG["email.send"], opts)
      );
    } catch (error) {
      logger.error("[queue-service] failed to add email job", { error, recipient: data.recipient });
      return undefined;
    }
  }

  async getQueueMetrics(): Promise<{
    notificationCounts: Record<string, number>;
    webhookCounts: Record<string, number>;
    emailCounts: Record<string, number>;
  }> {
    const [nWaiting, nActive, nFailed, nCompleted, wWaiting, wActive, wFailed, wCompleted, eWaiting, eActive, eFailed, eCompleted] = await Promise.all([
      this.notificationQueue.getWaitingCount(),
      this.notificationQueue.getActiveCount(),
      this.notificationQueue.getFailedCount(),
      this.notificationQueue.getCompletedCount(),
      this.webhookQueue.getWaitingCount(),
      this.webhookQueue.getActiveCount(),
      this.webhookQueue.getFailedCount(),
      this.webhookQueue.getCompletedCount(),
      this.emailQueue.getWaitingCount(),
      this.emailQueue.getActiveCount(),
      this.emailQueue.getFailedCount(),
      this.emailQueue.getCompletedCount(),
    ]);

    return {
      notificationCounts: { waiting: nWaiting, active: nActive, failed: nFailed, completed: nCompleted },
      webhookCounts: { waiting: wWaiting, active: wActive, failed: wFailed, completed: wCompleted },
      emailCounts: { waiting: eWaiting, active: eActive, failed: eFailed, completed: eCompleted },
    };
  }

  /**
   * Collects per-lane depth and wait time directly from Redis so the numbers
   * are accurate across instances (issue #985). Lane depth comes from BullMQ's
   * per-priority counts; wait time is derived from the oldest waiting jobs.
   */
  private async collectLaneMetrics(now: number = Date.now()): Promise<LaneMetrics> {
    const queues: Array<Queue<any>> = [
      this.notificationQueue,
      this.webhookQueue,
      this.emailQueue,
      this.analyticsQueue,
    ];
    const priorities = JOB_LANES.map((lane) => LANE_PRIORITY[lane]);

    const [countsByQueue, jobsByQueue] = await Promise.all([
      Promise.all(
        queues.map((queue) => {
          if (typeof queue.getCountsPerPriority !== "function") {
            return Promise.resolve({} as Record<number, number>);
          }
          return queue.getCountsPerPriority(priorities).catch((error) => {
            logger.warn("[queue-service] could not read lane depth", { error });
            return {} as Record<number, number>;
          });
        })
      ),
      Promise.all(
        queues.map((queue) => {
          if (typeof queue.getJobs !== "function") return Promise.resolve([]);
          return queue.getJobs(["waiting", "prioritized"], 0, 999, true).catch((error) => {
            logger.warn("[queue-service] could not read lane wait times", { error });
            return [];
          });
        })
      ),
    ]);

    const metrics = emptyLaneMetrics();
    for (const counts of countsByQueue) {
      const perPriority = counts as Record<string | number, number>;
      for (const lane of JOB_LANES) {
        metrics[lane].depth += Number(perPriority[LANE_PRIORITY[lane]] ?? 0);
      }
    }

    const waitTotals: Record<JobLane, { sum: number; count: number }> = {
      [JobLane.HIGH]: { sum: 0, count: 0 },
      [JobLane.NORMAL]: { sum: 0, count: 0 },
      [JobLane.LOW]: { sum: 0, count: 0 },
    };

    for (const jobs of jobsByQueue) {
      for (const job of jobs) {
        const lane = laneForPriority(job.priority);
        const waitMs = Math.max(0, now - job.timestamp);
        metrics[lane].oldestWaitMs = Math.max(metrics[lane].oldestWaitMs, waitMs);
        waitTotals[lane].sum += waitMs;
        waitTotals[lane].count += 1;
      }
    }

    for (const lane of JOB_LANES) {
      const totals = waitTotals[lane];
      metrics[lane].avgWaitMs = totals.count > 0 ? totals.sum / totals.count : 0;
    }

    return metrics;
  }

  /**
   * Fair-share safety net for the live BullMQ queues (issue #985). BullMQ only
   * orders by priority, so a continuous high-lane stream can still starve low
   * jobs. Any low-lane job that has waited past the starvation threshold is
   * promoted to high priority, preserving its original enqueue timestamp so it
   * jumps ahead of newer high-lane work.
   */
  async rebalanceAgedJobs(now: number = Date.now()): Promise<{ promoted: number }> {
    const thresholdMs = Number(process.env.QUEUE_STARVATION_THRESHOLD_MS || 30_000);
    const queues: Array<Queue<any>> = [
      this.notificationQueue,
      this.webhookQueue,
      this.emailQueue,
      this.analyticsQueue,
    ];

    let promoted = 0;
    for (const queue of queues) {
      if (typeof queue.getJobs !== "function") continue;
      let jobs: Array<Job<any>>;
      try {
        jobs = await queue.getJobs(["waiting", "prioritized"], 0, 999, true);
      } catch (error) {
        logger.warn("[queue-service] could not read jobs for lane rebalance", { error });
        continue;
      }

      for (const job of jobs) {
        if (laneForPriority(job.priority) !== JobLane.LOW) continue;
        if (now - job.timestamp <= thresholdMs) continue;
        if (typeof job.changePriority !== "function") continue;

        try {
          await job.changePriority({ priority: LANE_PRIORITY[JobLane.HIGH] });
          promoted += 1;
        } catch (error) {
          logger.warn("[queue-service] failed to promote aged low-lane job", {
            error,
            jobId: job.id,
          });
        }
      }
    }

    if (promoted > 0) {
      logger.info("[queue-service] promoted aged low-lane jobs", { promoted, thresholdMs });
    }
    return { promoted };
  }

  /** Refreshes the per-lane Prometheus gauges and returns the same snapshot. */
  async refreshLaneMetrics(): Promise<LaneMetrics> {
    const lanes = await this.collectLaneMetrics();
    for (const lane of JOB_LANES) {
      const label = laneLabel(lane);
      queueLaneDepth.set({ lane: label }, lanes[lane].depth);
      queueLaneOldestWaitSeconds.set({ lane: label }, lanes[lane].oldestWaitMs / 1000);
      queueLaneAvgWaitSeconds.set({ lane: label }, lanes[lane].avgWaitMs / 1000);
    }
    return lanes;
  }

  /**
   * Fairness snapshot for the queues (issues #862 and #985): observed wait time
   * per priority class, the current waiting mix, a starvation report, and live
   * per-lane depth/wait metrics.
   */
  async getFairnessMetrics(): Promise<FairnessMetrics> {
    return {
      waitByPriority: fairQueue.waitTimeByPriority(),
      waitingByPriority: fairQueue.waitingCounts(),
      starvation: fairQueue.starvationReport(),
      lanes: await this.refreshLaneMetrics(),
    };
  }

  async close(): Promise<void> {
    const queues = [this.notificationQueue, this.webhookQueue, this.emailQueue, this.analyticsQueue];
    await Promise.allSettled(queues.map((q) => q.close()));
    this.initialized = false;
    logger.info("[queue-service] all queues closed");
  }
}

export const queueService = new QueueService();
