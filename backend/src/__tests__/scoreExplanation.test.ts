// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Score explanation endpoint with counterfactual hints (issue #978).
 */

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

jest.mock("../services/db.js", () => ({
  getApplicant: jest.fn(),
  getBorrowerStatus: jest.fn(),
}));

import { borrowerRouter } from "../routes/borrower.js";
import { getApplicant } from "../services/db.js";
import { calculateCreditScore, updateModelConfig } from "../services/scoring.js";
import { explainScore, type StoredScoreInputs } from "../services/scoreExplanation.js";
import type { RemittanceAnalysis } from "../services/stellar.js";

const getApplicantMock = getApplicant as jest.Mock;

const OWNER = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();
const ADMIN = Keypair.random().publicKey();
process.env.ADMIN_WALLET_ADDRESS = ADMIN;

beforeAll(() => updateModelConfig({ shadowModeEnabled: false }));

function analysis(overrides: Partial<RemittanceAnalysis>): RemittanceAnalysis {
  return {
    senderAddress: OWNER,
    recipientAddress: OTHER,
    selfDealing: false,
    eligible: true,
    reason: "",
    totalPayments: 6,
    totalAmountUSDC: "1500",
    averageAmountUSDC: "250",
    standardDeviation: 125,
    firstPayment: null,
    lastPayment: null,
    spanMonths: 5,
    ...overrides,
  };
}

/** Scores an analysis and returns what `VerificationResult` would store. */
function stored(a: RemittanceAnalysis): StoredScoreInputs & { score: number } {
  const result = calculateCreditScore(a);
  return {
    totalPayments: a.totalPayments,
    totalVolume: Number(a.totalAmountUSDC),
    spanMonths: a.spanMonths,
    scoreBreakdown: result.breakdown,
    score: result.score,
  };
}

describe("explainScore", () => {
  const cases: [string, RemittanceAnalysis][] = [
    ["mid score", analysis({})],
    ["sparse history", analysis({ totalPayments: 3, spanMonths: 7, totalAmountUSDC: "300", averageAmountUSDC: "100", standardDeviation: 80 })],
    ["strong history", analysis({ totalPayments: 14, spanMonths: 13, totalAmountUSDC: "7000", averageAmountUSDC: "500", standardDeviation: 20 })],
  ];

  it.each(cases)("factor contributions add up to the stored score (%s)", (_name, a) => {
    const inputs = stored(a);
    const explanation = explainScore(inputs);

    expect(explanation.score).toBe(inputs.score);
    expect(explanation.factors).toHaveLength(4);
    expect(explanation.factors.reduce((sum, f) => sum + f.contribution, 0)).toBe(explanation.score);
  });

  it("gives at most three hints, for the factors holding the score back the most", () => {
    const explanation = explainScore(stored(analysis({})));
    const byDeficit = explanation.factors
      .filter((f) => f.maxContribution > f.contribution)
      .slice(0, 3)
      .map((f) => f.factor);

    expect(explanation.nextBand).toEqual({ tier: "Good", minScore: 60 });
    expect(explanation.hints.length).toBeLessThanOrEqual(3);
    expect(explanation.hints.map((h) => h.factor)).toEqual(byDeficit.slice(0, explanation.hints.length));
  });

  it("hints that reach the next band really do, and are the smallest such step", () => {
    const inputs = stored(analysis({}));
    const explanation = explainScore(inputs);
    const reaching = explanation.hints.filter((h) => h.reachesNextBand);

    expect(reaching.length).toBeGreaterThan(0);
    for (const hint of reaching) {
      expect(hint.projectedScore).toBeGreaterThanOrEqual(explanation.nextBand!.minScore);
      expect(hint.target).not.toBe(hint.current);
      expect(hint.change.length).toBeGreaterThan(0);
    }

    // Score 55 with 5 months of history: 6 months is the smallest duration
    // step, and it lifts the score into the Good band.
    const duration = explanation.hints.find((h) => h.factor === "duration");
    expect(duration).toMatchObject({ current: 5, target: 6, reachesNextBand: true });
  });

  it("returns no hints for a score already in the top band", () => {
    const explanation = explainScore(
      stored(analysis({ totalPayments: 14, spanMonths: 13, totalAmountUSDC: "7000", averageAmountUSDC: "500", standardDeviation: 20 }))
    );
    expect(explanation.tier).toBe("Excellent");
    expect(explanation.nextBand).toBeNull();
    expect(explanation.hints).toEqual([]);
  });

  it("returns no hints when there is not enough history to score", () => {
    const explanation = explainScore({ totalPayments: 1, totalVolume: 100, spanMonths: 0, scoreBreakdown: null });
    expect(explanation.score).toBe(0);
    expect(explanation.hints).toEqual([]);
  });
});

describe("GET /api/borrower/:address/score-explanation", () => {
  function makeApp(walletAddress?: string) {
    const app = express();
    if (walletAddress) {
      app.use((req, _res, next) => {
        (req as any).user = { walletAddress, network: "testnet" };
        next();
      });
    }
    app.use("/api/borrower", borrowerRouter);
    return app;
  }

  const inputs = stored(analysis({}));

  beforeEach(() => {
    jest.clearAllMocks();
    getApplicantMock.mockResolvedValue({
      verificationResults: [{ ...inputs, modelVersion: "v1.0.0", analyzedAt: new Date("2026-11-01T00:00:00Z") }],
    });
  });

  it("returns the explanation to the applicant", async () => {
    const res = await request(makeApp(OWNER)).get(`/api/borrower/${OWNER}/score-explanation`);

    expect(res.status).toBe(200);
    expect(res.body.score).toBe(inputs.score);
    expect(res.body.factors.reduce((s: number, f: { contribution: number }) => s + f.contribution, 0)).toBe(inputs.score);
    expect(res.body.modelVersion).toBe("v1.0.0");
  });

  it("returns the explanation to an admin", async () => {
    const res = await request(makeApp(ADMIN)).get(`/api/borrower/${OWNER}/score-explanation`);
    expect(res.status).toBe(200);
  });

  it("forbids an applicant from reading another applicant's explanation", async () => {
    const res = await request(makeApp(OTHER)).get(`/api/borrower/${OWNER}/score-explanation`);

    expect(res.status).toBe(403);
    expect(getApplicantMock).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller", async () => {
    const res = await request(makeApp()).get(`/api/borrower/${OWNER}/score-explanation`);
    expect(res.status).toBe(401);
  });

  it("404s when no score has been computed", async () => {
    getApplicantMock.mockResolvedValue(null);
    const res = await request(makeApp(OWNER)).get(`/api/borrower/${OWNER}/score-explanation`);
    expect(res.status).toBe(404);
  });
});
