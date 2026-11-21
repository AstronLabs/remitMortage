// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Conditional GET coverage for the read-heavy endpoints named in issue #983:
 * the loan list, lending-pool stats and the investor offering list.
 */

import express from "express";
import request from "supertest";

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/loanStore.js", () => ({
  createApplication: jest.fn(),
  getApplication: jest.fn(),
  getApplicationsByBorrower: jest.fn(),
  getPendingApplications: jest.fn(),
  updateApplication: jest.fn(),
  resumeDraftApplication: jest.fn(),
  discardDraftApplication: jest.fn(),
  escrowTargetMetForAmount: jest.fn(),
  StaleVersionError: class StaleVersionError extends Error {},
}));
jest.mock("../services/autoRejectionRuleStore.js", () => ({ applyAutoRejectionIfNeeded: jest.fn() }));
jest.mock("../services/guarantor.js", () => ({
  verifyStellarGuarantorSignature: jest.fn(),
  buildGuarantorCommitment: jest.fn(),
}));
jest.mock("../services/notification.js", () => ({ queueNotification: jest.fn() }));
jest.mock("../services/offeringWatchlist.js", () => ({
  notifyWatchersOfOpenedOffering: jest.fn(),
  listUpcomingOfferings: jest.fn(),
  listWatchlist: jest.fn(),
}));
jest.mock("../jobs/kycExpiryReminder.js", () => ({ hasExpiredKycDocuments: jest.fn() }));
jest.mock("../services/db.js", () => ({ prisma: {} }));
jest.mock("../services/taxIdDedup.js", () => ({
  findTaxIdMatches: jest.fn(),
  recordApplicantTaxIdHash: jest.fn(),
  DUPLICATE_TAX_ID_REVIEW_REASON: "DUPLICATE_TAX_ID",
}));
jest.mock("../services/loanHistory.js", () => ({ reconstructLoanApplicationAt: jest.fn() }));
jest.mock("../services/loanActivityTimeline.js", () => {
  class InvalidActivityCursorError extends Error {}
  return { InvalidActivityCursorError, getLoanActivityTimeline: jest.fn() };
});
jest.mock("../utils/fuzzyMatch.js", () => ({
  checkDuplicateApplicants: jest.fn(),
  logReviewerDecision: jest.fn(),
  ApplicantFields: {},
}));
jest.mock("../security/requireResourceOwnership.js", () => ({
  requireBorrowerAddressOwnership: jest.fn(() => true),
  requireLoanAdmin: jest.fn(),
  requireLoanOwnership: jest.fn(),
}));

jest.mock("../services/analytics.js", () => ({
  getProtocolOverview: jest.fn(),
  getLoanPerformance: jest.fn(),
  getDisbursementProgress: jest.fn(),
  getMonthlyVolume: jest.fn(),
  getProtocolOverviewFromView: jest.fn(),
  getLoanPerformanceFromView: jest.fn(),
  getDisbursementProgressFromView: jest.fn(),
  getMonthlyVolumeFromView: jest.fn(),
}));
jest.mock("../services/soroban.js", () => ({ getLendingPoolRates: jest.fn() }));
jest.mock("../services/fx.js", () => ({ convertUsdTo: jest.fn() }));
jest.mock("../services/feeEstimator.js", () => ({
  feeEstimator: { getRecommendation: jest.fn() },
}));
jest.mock("../services/analyticsEvents.js", () => ({
  enqueueAnalyticsEvents: jest.fn(),
  getAnalyticsCounts: jest.fn(),
  getAnalyticsFunnel: jest.fn(),
  MAX_ANALYTICS_BATCH_SIZE: 50,
  validateAnalyticsInput: jest.fn(() => true),
}));
jest.mock("../middleware/cache.js", () => ({
  cacheMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock("../middleware/auth.js", () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock("../middleware/readYourWrites.js", () => ({
  readYourWritesSessionKey: jest.fn(),
}));

import { loanRouter } from "../routes/loan.js";
import { analyticsRouter } from "../routes/analytics.js";
import { watchlistRouter } from "../routes/watchlist.js";
import { getPendingApplications } from "../services/loanStore.js";
import { getLendingPoolRates } from "../services/soroban.js";
import { listUpcomingOfferings } from "../services/offeringWatchlist.js";

const getPendingMock = getPendingApplications as jest.Mock;
const getPoolRatesMock = getLendingPoolRates as jest.Mock;
const listOfferingsMock = listUpcomingOfferings as jest.Mock;

const ORIGINAL_POOL_CONTRACT_ID = process.env.LENDING_POOL_CONTRACT_ID;

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const walletAddress = req.headers["x-user"];
  if (typeof walletAddress === "string") {
    (req as any).user = { walletAddress, network: "testnet" };
  }
  next();
});
app.use("/api/loan", loanRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/watchlist", watchlistRouter);

beforeEach(() => {
  jest.clearAllMocks();
  process.env.LENDING_POOL_CONTRACT_ID = "CPOOLCONTRACT";
});

afterEach(() => {
  if (ORIGINAL_POOL_CONTRACT_ID === undefined) {
    delete process.env.LENDING_POOL_CONTRACT_ID;
  } else {
    process.env.LENDING_POOL_CONTRACT_ID = ORIGINAL_POOL_CONTRACT_ID;
  }
});

describe("conditional GET on read-heavy endpoints (issue #983)", () => {
  describe("GET /api/loan/pending (loan list)", () => {
    it("returns 304 for a matching tag and 200 for a mismatch", async () => {
      getPendingMock.mockResolvedValue([{ id: "loan-1", principal: 50000, status: "Pending" }]);

      const first = await request(app).get("/api/loan/pending");
      expect(first.status).toBe(200);
      expect(first.headers.etag).toMatch(/^"[^"]+"$/);

      const matched = await request(app)
        .get("/api/loan/pending")
        .set("If-None-Match", first.headers.etag);
      expect(matched.status).toBe(304);
      expect(matched.text).toBe("");

      const mismatched = await request(app)
        .get("/api/loan/pending")
        .set("If-None-Match", '"stale-tag"');
      expect(mismatched.status).toBe(200);
    });

    it("changes the tag when the loan list changes", async () => {
      getPendingMock.mockResolvedValue([{ id: "loan-1", principal: 50000, status: "Pending" }]);
      const first = await request(app).get("/api/loan/pending");

      getPendingMock.mockResolvedValue([
        { id: "loan-1", principal: 50000, status: "Pending" },
        { id: "loan-2", principal: 80000, status: "Pending" },
      ]);
      const second = await request(app).get("/api/loan/pending");

      expect(second.headers.etag).not.toBe(first.headers.etag);
    });
  });

  describe("GET /api/analytics/pool-rates (pool stats)", () => {
    it("returns 304 for a matching tag and a new tag when rates change", async () => {
      getPoolRatesMock.mockResolvedValue({
        poolApyBps: 1000,
        seniorApyBps: 400,
        juniorApyBps: 1900,
        seniorLiquidity: "600",
        juniorLiquidity: "400",
      });

      const first = await request(app).get("/api/analytics/pool-rates");
      expect(first.status).toBe(200);

      const matched = await request(app)
        .get("/api/analytics/pool-rates")
        .set("If-None-Match", first.headers.etag);
      expect(matched.status).toBe(304);

      getPoolRatesMock.mockResolvedValue({
        poolApyBps: 1100,
        seniorApyBps: 450,
        juniorApyBps: 2000,
        seniorLiquidity: "650",
        juniorLiquidity: "350",
      });

      const changed = await request(app).get("/api/analytics/pool-rates");
      expect(changed.status).toBe(200);
      expect(changed.headers.etag).not.toBe(first.headers.etag);
    });
  });

  describe("GET /api/watchlist/upcoming (offering list)", () => {
    it("never shares a tag between users", async () => {
      const offerings = [
        { id: "loan-1", principal: 50000, interestRateBps: 850, createdAt: "2026-11-01T00:00:00.000Z", watched: false },
      ];
      listOfferingsMock.mockResolvedValue(offerings);

      const alice = await request(app).get("/api/watchlist/upcoming").set("x-user", "GALICE");
      const bob = await request(app).get("/api/watchlist/upcoming").set("x-user", "GBOB");

      expect(alice.status).toBe(200);
      expect(bob.status).toBe(200);
      expect(alice.body).toEqual(bob.body);
      expect(alice.headers.etag).not.toBe(bob.headers.etag);

      const bobUsingAliceTag = await request(app)
        .get("/api/watchlist/upcoming")
        .set("x-user", "GBOB")
        .set("If-None-Match", alice.headers.etag);
      expect(bobUsingAliceTag.status).toBe(200);

      const bobRevalidates = await request(app)
        .get("/api/watchlist/upcoming")
        .set("x-user", "GBOB")
        .set("If-None-Match", bob.headers.etag);
      expect(bobRevalidates.status).toBe(304);
    });
  });
});
