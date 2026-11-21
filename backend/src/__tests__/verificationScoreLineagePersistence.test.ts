// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";

const analysis = {
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

const scoreResult = {
  score: 100,
  modelVersion: "v1.0.0",
  breakdown: { consistency: 40, frequency: 25, duration: 20, volume: 15 },
  tier: "Excellent",
  reasons: [],
};

const lineageRecord = {
  inputs: analysis,
  score: 100,
  modelVersion: "v1.0.0",
  computedAt: new Date("2026-11-20T12:00:00.000Z"),
  expiresAt: new Date("2027-11-20T12:00:00.000Z"),
};

const analyzeRemittanceHistoryMock = jest.fn();
const calculateCreditScoreMock = jest.fn();
const buildScoreLineageRecordMock = jest.fn();
const upsertApplicantMock = jest.fn();
const createVerificationResultMock = jest.fn();

jest.mock("../services/stellar.js", () => ({
  analyzeRemittanceHistory: (...args: unknown[]) => analyzeRemittanceHistoryMock(...args),
}));

jest.mock("../services/pdf.js", () => ({
  hashReportContent: () => "report-hash",
  streamVerificationPdf: jest.fn(),
}));

jest.mock("../services/scoring.js", () => ({
  calculateCreditScore: (...args: unknown[]) => calculateCreditScoreMock(...args),
}));

jest.mock("../services/scoreLineage.js", () => ({
  buildScoreLineageRecord: (...args: unknown[]) => buildScoreLineageRecordMock(...args),
}));

jest.mock("../middleware/validate.js", () => ({
  validateVerificationBody: (_req: unknown, _res: unknown, next: () => void) => next(),
  validateWalletAddress: (_req: unknown, _res: unknown, next: () => void) => next(),
  validateMultiChainOwnership: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middleware/rateLimit.js", () => ({
  verificationChallengeRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  verificationOwnershipRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../services/db.js", () => ({
  prisma: {},
  upsertApplicant: (...args: unknown[]) => upsertApplicantMock(...args),
  createVerificationResult: (...args: unknown[]) => createVerificationResultMock(...args),
  getNotificationPreference: jest.fn(),
}));

jest.mock("../services/challengeStore.js", () => ({
  createChallenge: jest.fn(),
  consumeChallenge: jest.fn(),
}));

jest.mock("../services/evm.js", () => ({ verifyEvmSignature: jest.fn() }));
jest.mock("../services/solana.js", () => ({ verifySolanaSignature: jest.fn() }));
jest.mock("../services/locationAnomalyService.js", () => ({
  evaluateLoginLocation: jest.fn(),
  recordLoginLocation: jest.fn(),
  generateStepUpCode: jest.fn(),
  verifyStepUpCode: jest.fn(),
}));
jest.mock("../services/audit.js", () => ({ logAudit: jest.fn() }));
jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn(),
  getBrandedHtml: jest.fn(),
}));

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { verificationRouter } from "../routes/verification.js";

const app = express();
app.use(express.json());
app.use("/api/verification", verificationRouter);

describe("POST /api/verification/check score lineage persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    analyzeRemittanceHistoryMock.mockResolvedValue(analysis);
    calculateCreditScoreMock.mockReturnValue(scoreResult);
    buildScoreLineageRecordMock.mockReturnValue(lineageRecord);
    upsertApplicantMock.mockResolvedValue({ id: "applicant-1" });
    createVerificationResultMock.mockResolvedValue({ id: "score-1" });
  });

  it("writes the score and its lineage together", async () => {
    const res = await request(app)
      .post("/api/verification/check")
      .send({ senderAddress: analysis.senderAddress, recipientAddress: analysis.recipientAddress });

    expect(res.status).toBe(200);
    expect(buildScoreLineageRecordMock).toHaveBeenCalledWith({
      analysis,
      score: scoreResult.score,
      modelVersion: scoreResult.modelVersion,
    });
    expect(createVerificationResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        applicantId: "applicant-1",
        score: scoreResult.score,
        modelVersion: scoreResult.modelVersion,
        lineage: {
          inputs: lineageRecord.inputs,
          computedAt: lineageRecord.computedAt,
          expiresAt: lineageRecord.expiresAt,
        },
      })
    );
  });
});
