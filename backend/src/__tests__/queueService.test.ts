// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockAdd = jest.fn().mockResolvedValue({ id: "mock-job-id" });
const mockWaitUntilReady = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockGetWaitingCount = jest.fn().mockResolvedValue(0);
const mockGetActiveCount = jest.fn().mockResolvedValue(0);
const mockGetFailedCount = jest.fn().mockResolvedValue(0);
const mockGetCompletedCount = jest.fn().mockResolvedValue(0);
const mockGetCountsPerPriority = jest.fn().mockResolvedValue({});
const mockGetJobs = jest.fn().mockResolvedValue([]);

const mockQueueInstance = {
  add: mockAdd,
  waitUntilReady: mockWaitUntilReady,
  close: mockClose,
  getWaitingCount: mockGetWaitingCount,
  getActiveCount: mockGetActiveCount,
  getFailedCount: mockGetFailedCount,
  getCompletedCount: mockGetCompletedCount,
  getCountsPerPriority: mockGetCountsPerPriority,
  getJobs: mockGetJobs,
  name: "mock-queue",
};

jest.mock("bullmq", () => ({
  Queue: jest.fn(() => mockQueueInstance),
  Worker: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    waitUntilReady: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("../services/redisCluster", () => ({
  getClusterClient: jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    ping: jest.fn().mockResolvedValue("PONG"),
    status: "ready",
  })),
  isClusterMode: jest.fn(() => false),
  getClusterStatus: jest.fn(() => ({
    mode: "single",
    connected: true,
    nodeCount: 1,
  })),
  initializeRedisCluster: jest.fn(),
  closeCluster: jest.fn(),
}));

import { queueService } from "../services/queueService.js";

describe("Queue Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCountsPerPriority.mockResolvedValue({});
    mockGetJobs.mockResolvedValue([]);
  });

  describe("addNotificationJob", () => {
    it("adds job to notification queue when initialized", async () => {
      await queueService.initialize();

      const addSpy = mockQueueInstance.add;
      addSpy.mockClear();

      const jobData = {
        notificationId: "notif-1",
        recipient: "test@example.com",
        type: "EMAIL" as const,
        content: "test content",
      };

      const result = await queueService.addNotificationJob(jobData);
      expect(result).toBeDefined();
      expect(addSpy).toHaveBeenCalledWith(
        "send-notification",
        jobData,
        expect.objectContaining({ priority: 1 })
      );
    });
  });

  describe("addWebhookJob", () => {
    it("adds job to webhook queue when initialized", async () => {
      await queueService.initialize();

      const addSpy = mockQueueInstance.add;
      addSpy.mockClear();

      const jobData = {
        subscriptionId: "sub-1",
        url: "https://example.com/webhook",
        encryptedSecret: "encrypted-secret",
        topic: "deposit" as const,
        data: {
          contractId: "contract-1",
          borrower: "borrower-1",
          amount: "1000",
          ledger: 12345,
        },
        attempt: 0,
      };

      const result = await queueService.addWebhookJob(jobData);
      expect(result).toBeDefined();
      expect(addSpy).toHaveBeenCalledWith(
        "deliver-webhook",
        jobData,
        expect.objectContaining({ priority: 2 })
      );
    });
  });

  describe("priority lanes", () => {
    it("puts analytics in the low lane and transactional email in the normal lane", async () => {
      await queueService.initialize();

      const addSpy = mockQueueInstance.add;
      addSpy.mockClear();

      await queueService.addAnalyticsJob({ events: [] });
      expect(addSpy).toHaveBeenCalledWith(
        "persist-analytics",
        { events: [] },
        expect.objectContaining({ priority: 3 })
      );

      await queueService.addEmailJob({
        recipient: "test@example.com",
        subject: "Subject",
        content: "Body",
      });
      expect(addSpy).toHaveBeenCalledWith(
        "send-email",
        expect.objectContaining({ recipient: "test@example.com" }),
        expect.objectContaining({ priority: 2 })
      );
    });

    it("promotes low-lane jobs that have waited past the fair-share threshold", async () => {
      await queueService.initialize();

      const now = Date.now();
      const agedChangePriority = jest.fn().mockResolvedValue(undefined);
      const freshChangePriority = jest.fn().mockResolvedValue(undefined);
      const highChangePriority = jest.fn().mockResolvedValue(undefined);

      mockGetJobs.mockResolvedValueOnce([
        { id: "low-aged", priority: 3, timestamp: now - 60_000, changePriority: agedChangePriority },
        { id: "low-fresh", priority: 3, timestamp: now - 1_000, changePriority: freshChangePriority },
        { id: "high-aged", priority: 1, timestamp: now - 60_000, changePriority: highChangePriority },
      ]).mockResolvedValue([]);

      const result = await queueService.rebalanceAgedJobs(now);

      expect(result.promoted).toBe(1);
      expect(agedChangePriority).toHaveBeenCalledWith({ priority: 1 });
      expect(freshChangePriority).not.toHaveBeenCalled();
      expect(highChangePriority).not.toHaveBeenCalled();
    });

    it("exposes per-lane depth and wait time metrics", async () => {
      await queueService.initialize();

      // Every queue reports the same snapshot in this mock.
      mockGetCountsPerPriority.mockResolvedValue({ 1: 2, 2: 1, 3: 3 });
      const now = Date.now();
      mockGetJobs.mockResolvedValue([
        { id: "high-1", priority: 1, timestamp: now - 1000 },
        { id: "low-1", priority: 3, timestamp: now - 5000 },
      ]);

      const lanes = await queueService.refreshLaneMetrics();

      expect(lanes.high.depth).toBe(8);
      expect(lanes.normal.depth).toBe(4);
      expect(lanes.low.depth).toBe(12);
      expect(lanes.high.oldestWaitMs).toBeGreaterThanOrEqual(1000);
      expect(lanes.low.oldestWaitMs).toBeGreaterThanOrEqual(5000);
      expect(lanes.low.avgWaitMs).toBeGreaterThanOrEqual(5000);
    });
  });

  describe("getQueueMetrics", () => {
    it("returns counts for all queues", async () => {
      await queueService.initialize();

      const metrics = await queueService.getQueueMetrics();
      expect(metrics).toHaveProperty("notificationCounts");
      expect(metrics).toHaveProperty("webhookCounts");
      expect(metrics).toHaveProperty("emailCounts");
    });
  });

  describe("close", () => {
    it("closes all queues", async () => {
      await queueService.initialize();
      await expect(queueService.close()).resolves.toBeUndefined();
    });
  });
});
