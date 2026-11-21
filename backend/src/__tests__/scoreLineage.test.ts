// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import { calculateCreditScore } from "../services/scoring.js";
import {
  MS_PER_DAY,
  buildScoreLineageInputs,
  buildScoreLineageRecord,
  getScoreLineage,
  recomputeCreditScoreFromLineage,
} from "../services/scoreLineage.js";
import { runScoreLineageCleanupJob } from "../jobs/scoreLineageCleanup.js";
import type { RemittanceAnalysis } from "../services/stellar.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    scoreLineage: {
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    scoreLineageRetentionDays: 365,
  })),
}));

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const baseAnalysis: RemittanceAnalysis = {
  senderAddress: "G_TEST_SENDER",
  recipientAddress: "G_TEST_RECIPIENT",
  totalPayments: 12,
  totalAmountUSDC: "6000",
  averageAmountUSDC: "500",
  standardDeviation: 0,
  spanMonths: 12,
  firstPayment: "2023-01-01",
  lastPayment: "2024-01-01",
  selfDealing: false,
  eligible: true,
  reason: "OK",
};

describe("Score data lineage (#982)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("stores every scoring input needed to reproduce the score", () => {
    expect(buildScoreLineageInputs(baseAnalysis)).toEqual(baseAnalysis);
  });

  it.each([
    ["excellent", baseAnalysis],
    [
      "good",
      {
        ...baseAnalysis,
        totalPayments: 6,
        spanMonths: 6,
        totalAmountUSDC: "2500",
        averageAmountUSDC: "416.66",
      },
    ],
    [
      "fair",
      {
        ...baseAnalysis,
        totalPayments: 4,
        spanMonths: 3,
        totalAmountUSDC: "600",
        averageAmountUSDC: "150",
        standardDeviation: 75,
      },
    ],
    [
      "insufficient",
      { ...baseAnalysis, totalPayments: 1 },
    ],
  ])("recomputing from lineage inputs reproduces the stored %s score", (_label, analysis) => {
    const stored = calculateCreditScore(analysis);
    const lineage = buildScoreLineageRecord({
      analysis,
      score: stored.score,
      modelVersion: stored.modelVersion,
    });

    const recomputed = recomputeCreditScoreFromLineage(lineage.inputs);

    expect(recomputed.score).toBe(stored.score);
    expect(recomputed.tier).toBe(stored.tier);
    expect(recomputed.breakdown).toEqual(stored.breakdown);
    expect(recomputed.reasons).toEqual(stored.reasons);
    expect(lineage.score).toBe(stored.score);
    expect(lineage.modelVersion).toBe(stored.modelVersion);
  });

  it("stamps the expiresAt from the configured retention period", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const lineage = buildScoreLineageRecord({
      analysis: baseAnalysis,
      score: 100,
      modelVersion: "v1.0.0",
      now,
    });

    expect(lineage.computedAt).toEqual(now);
    expect(lineage.expiresAt).toEqual(new Date(now.getTime() + 365 * MS_PER_DAY));
  });

  it("accepts an explicit retention override", () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    const lineage = buildScoreLineageRecord({
      analysis: baseAnalysis,
      score: 100,
      modelVersion: "v1.0.0",
      retentionDays: 30,
      now,
    });

    expect(lineage.expiresAt).toEqual(new Date(now.getTime() + 30 * MS_PER_DAY));
  });

  it("rejects an invalid retention period", () => {
    expect(() =>
      buildScoreLineageRecord({
        analysis: baseAnalysis,
        score: 100,
        modelVersion: "v1.0.0",
        retentionDays: -1,
      })
    ).toThrow(/retentionDays/);
  });

  it("looks up lineage by the stored score id", async () => {
    const row = { id: "lineage-1", verificationResultId: "score-1" };
    (prisma.scoreLineage.findUnique as jest.Mock).mockResolvedValue(row);

    await expect(getScoreLineage("score-1")).resolves.toEqual(row);
    expect(prisma.scoreLineage.findUnique).toHaveBeenCalledWith({
      where: { verificationResultId: "score-1" },
      include: {
        verificationResult: {
          select: {
            id: true,
            applicantId: true,
            analyzedAt: true,
            score: true,
            modelVersion: true,
            eligible: true,
          },
        },
        applicant: { select: { id: true, stellarAddress: true } },
      },
    });
  });

  it("purges lineage whose retention window has elapsed", async () => {
    const now = new Date("2026-11-20T12:00:00.000Z");
    (prisma.scoreLineage.deleteMany as jest.Mock).mockResolvedValue({ count: 3 });

    const summary = await runScoreLineageCleanupJob(now);

    expect(summary.deletedCount).toBe(3);
    expect(summary.cutoff).toEqual(now);
    expect(prisma.scoreLineage.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
  });
});
