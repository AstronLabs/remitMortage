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

const mockQueueInstance = {
  add: mockAdd,
  waitUntilReady: mockWaitUntilReady,
  close: mockClose,
  getWaitingCount: mockGetWaitingCount,
  getActiveCount: mockGetActiveCount,
  getFailedCount: mockGetFailedCount,
  getCompletedCount: mockGetCompletedCount,
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
      expect(addSpy).toHaveBeenCalledWith("send-notification", jobData, undefined);
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
      expect(addSpy).toHaveBeenCalledWith("deliver-webhook", jobData, undefined);
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
