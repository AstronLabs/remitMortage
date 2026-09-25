// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { runSessionTokenPurgeJob } from "../jobs/sessionTokenPurge.js";
import { prisma } from "../services/db.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    sessionToken: {
      deleteMany: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
  },
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    sessionTokenRetentionDays: 7,
  })),
}));

describe("Session Token Auto-Purge Service & Job (#484)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should purge expired tokens older than the default retention period (7 days)", async () => {
    (prisma.sessionToken.deleteMany as jest.Mock).mockResolvedValue({
      count: 42,
    });

    const beforeCall = Date.now();
    const summary = await runSessionTokenPurgeJob();
    const afterCall = Date.now();

    expect(summary.deletedCount).toBe(42);
    expect(summary.retentionDays).toBe(7);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);

    const expectedCutoffApprox = beforeCall - 7 * 24 * 60 * 60 * 1000;
    expect(summary.cutoff.getTime()).toBeGreaterThanOrEqual(expectedCutoffApprox - 1000);
    expect(summary.cutoff.getTime()).toBeLessThanOrEqual(afterCall - 7 * 24 * 60 * 60 * 1000 + 1000);

    expect(prisma.sessionToken.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.sessionToken.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: {
          lt: expect.any(Date),
        },
      },
    });
  });

  it("should support custom override retentionDays", async () => {
    (prisma.sessionToken.deleteMany as jest.Mock).mockResolvedValue({
      count: 15,
    });

    const customDays = 14;
    const beforeCall = Date.now();
    const summary = await runSessionTokenPurgeJob(customDays);

    expect(summary.deletedCount).toBe(15);
    expect(summary.retentionDays).toBe(14);

    const expectedCutoffApprox = beforeCall - 14 * 24 * 60 * 60 * 1000;
    expect(summary.cutoff.getTime()).toBeGreaterThanOrEqual(expectedCutoffApprox - 1000);

    const deleteCallArg = (prisma.sessionToken.deleteMany as jest.Mock).mock.calls[0][0];
    const cutoffArg: Date = deleteCallArg.where.expiresAt.lt;
    expect(cutoffArg.getTime()).toBeCloseTo(expectedCutoffApprox, -3);
  });

  it("should return count 0 when no expired tokens meet the retention threshold", async () => {
    (prisma.sessionToken.deleteMany as jest.Mock).mockResolvedValue({
      count: 0,
    });

    const summary = await runSessionTokenPurgeJob(30);
    expect(summary.deletedCount).toBe(0);
    expect(summary.retentionDays).toBe(30);
  });

  it("should propagate database errors and log appropriately", async () => {
    const dbError = new Error("Database connection lost");
    (prisma.sessionToken.deleteMany as jest.Mock).mockRejectedValue(dbError);

    await expect(runSessionTokenPurgeJob()).rejects.toThrow("Database connection lost");
  });
});
