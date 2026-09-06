import { Queue, QueueOptions, Job, JobsOptions } from "bullmq";
import { getClusterClient, isClusterMode, getClusterStatus } from "./redisCluster.js";
import logger from "../utils/logger.js";

export type NotificationJobType = "EMAIL" | "WEBHOOK" | "SMS";

export interface NotificationJobData {
  notificationId: string;
  recipient: string;
  type: NotificationJobType;
  content: string;
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
      return await this.analyticsQueue.add("persist-analytics", data, opts);
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
      return await this.notificationQueue.add("send-notification", data, opts);
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
      return await this.webhookQueue.add("deliver-webhook", data, opts);
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
      return await this.emailQueue.add("send-email", data, opts);
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

  async close(): Promise<void> {
    const queues = [this.notificationQueue, this.webhookQueue, this.emailQueue, this.analyticsQueue];
    await Promise.allSettled(queues.map((q) => q.close()));
    this.initialized = false;
    logger.info("[queue-service] all queues closed");
  }
}

export const queueService = new QueueService();
