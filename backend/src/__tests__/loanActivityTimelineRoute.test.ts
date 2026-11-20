// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unified loan activity timeline (issue #1043) — route layer.
 *
 * The endpoint must be scoped exactly like `GET /api/loan/:id` (owner-or-admin)
 * and must surface an undecodable cursor as a 400 rather than a 500. These
 * tests mount the real router and the real ownership gate, mocking only the
 * loan lookup and the timeline service.
 */

import express from "express";
import request from "supertest";
import { loanFactory } from "../test-utils/factories/index.js";

const ADMIN_WALLET = "G" + "A".repeat(55);
const OWNER_WALLET = "G" + "B".repeat(55);
const OTHER_WALLET = "G" + "C".repeat(55);
process.env.ADMIN_WALLET_ADDRESS = ADMIN_WALLET;

jest.mock("../services/loanStore.js", () => ({
  createApplication: jest.fn(),
  getApplication: jest.fn(),
  getApplicationsByBorrower: jest.fn(),
  getPendingApplications: jest.fn(),
  updateApplication: jest.fn(),
  resumeDraftApplication: jest.fn(),
  discardDraftApplication: jest.fn(),
  escrowTargetMetForAmount: jest.fn(),
}));
jest.mock("../services/autoRejectionRuleStore.js", () => ({ applyAutoRejectionIfNeeded: jest.fn() }));
jest.mock("../services/guarantor.js", () => ({
  verifyStellarGuarantorSignature: jest.fn(),
  buildGuarantorCommitment: jest.fn(),
}));
jest.mock("../services/notification.js", () => ({ queueNotification: jest.fn() }));
jest.mock("../services/offeringWatchlist.js", () => ({ notifyWatchersOfOpenedOffering: jest.fn() }));
jest.mock("../jobs/kycExpiryReminder.js", () => ({ hasExpiredKycDocuments: jest.fn() }));
jest.mock("../services/db.js", () => ({ prisma: {} }));
jest.mock("../services/taxIdDedup.js", () => ({
  findTaxIdMatches: jest.fn(),
  recordApplicantTaxIdHash: jest.fn(),
  DUPLICATE_TAX_ID_REVIEW_REASON: "DUPLICATE_TAX_ID",
}));
jest.mock("../services/loanHistory.js", () => ({ reconstructLoanApplicationAt: jest.fn() }));
jest.mock("../utils/fuzzyMatch.js", () => ({
  checkDuplicateApplicants: jest.fn(),
  logReviewerDecision: jest.fn(),
  ApplicantFields: {},
}));
// A local error class keeps the route's `instanceof` check working without
// loading the real service (and its Prisma/loanHistory dependencies).
jest.mock("../services/loanActivityTimeline.js", () => {
  class InvalidActivityCursorError extends Error {
    readonly code = "invalid_cursor";
    constructor() {
      super("cursor is not a valid activity timeline cursor");
      this.name = "InvalidActivityCursorError";
    }
  }
  return { InvalidActivityCursorError, getLoanActivityTimeline: jest.fn() };
});

import { loanRouter } from "../routes/loan.js";
import { getApplication } from "../services/loanStore.js";
import {
  getLoanActivityTimeline,
  InvalidActivityCursorError,
} from "../services/loanActivityTimeline.js";

const getApplicationMock = getApplication as jest.Mock;
const getTimelineMock = getLoanActivityTimeline as jest.Mock;

const LOAN = loanFactory.build({ id: "loan-1", borrowerAddress: OWNER_WALLET });

/** Mounts the router with an optional authenticated caller. */
function makeApp(user?: { walletAddress: string; network: string }) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      (req as any).user = user;
      next();
    });
  }
  app.use("/api/loan", loanRouter);
  return app;
}

const ownerApp = makeApp({ walletAddress: OWNER_WALLET, network: "testnet" });
const adminApp = makeApp({ walletAddress: ADMIN_WALLET, network: "testnet" });
const otherApp = makeApp({ walletAddress: OTHER_WALLET, network: "testnet" });
const anonApp = makeApp();

const EMPTY_TIMELINE = {
  loanId: "loan-1",
  events: [],
  pagination: { limit: 20, cursor: null, nextCursor: null, hasNextPage: false },
};

beforeEach(() => {
  jest.clearAllMocks();
  getApplicationMock.mockResolvedValue(LOAN);
  getTimelineMock.mockResolvedValue(EMPTY_TIMELINE);
});

describe("GET /api/loan/:id/activity — access control", () => {
  it("401s an unauthenticated caller", async () => {
    const res = await request(anonApp).get("/api/loan/loan-1/activity");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(getTimelineMock).not.toHaveBeenCalled();
  });

  it("403s an authenticated caller who does not own the loan", async () => {
    const res = await request(otherApp).get("/api/loan/loan-1/activity");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
    expect(getTimelineMock).not.toHaveBeenCalled();
  });

  it("404s a loan that does not exist", async () => {
    getApplicationMock.mockResolvedValueOnce(null);

    const res = await request(ownerApp).get("/api/loan/missing/activity");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(getTimelineMock).not.toHaveBeenCalled();
  });

  it("200s the owning borrower and scopes the feed to their loan", async () => {
    const res = await request(ownerApp).get("/api/loan/loan-1/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY_TIMELINE);
    expect(getTimelineMock).toHaveBeenCalledWith(
      { id: "loan-1", borrowerAddress: OWNER_WALLET },
      { limit: undefined, cursor: undefined }
    );
  });

  it("200s an admin even when they are not the borrower", async () => {
    const res = await request(adminApp).get("/api/loan/loan-1/activity");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(EMPTY_TIMELINE);
  });
});

describe("GET /api/loan/:id/activity — query handling", () => {
  it("passes limit and cursor through to the service", async () => {
    getTimelineMock.mockResolvedValueOnce({
      ...EMPTY_TIMELINE,
      pagination: { limit: 5, cursor: "abc", nextCursor: null, hasNextPage: false },
    });

    const res = await request(ownerApp)
      .get("/api/loan/loan-1/activity")
      .query({ limit: "5", cursor: "abc" });

    expect(res.status).toBe(200);
    expect(getTimelineMock).toHaveBeenCalledWith(
      { id: "loan-1", borrowerAddress: OWNER_WALLET },
      { limit: 5, cursor: "abc" }
    );
  });

  it("400s a non-positive or non-integer limit without calling the service", async () => {
    for (const bad of ["0", "-1", "2.5", "abc"]) {
      const res = await request(ownerApp)
        .get("/api/loan/loan-1/activity")
        .query({ limit: bad });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({ error: "invalid_limit", field: "limit" })
      );
    }
    expect(getTimelineMock).not.toHaveBeenCalled();
  });

  it("400s an undecodable cursor", async () => {
    getTimelineMock.mockRejectedValueOnce(new InvalidActivityCursorError());

    const res = await request(ownerApp)
      .get("/api/loan/loan-1/activity")
      .query({ cursor: "not-a-cursor" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(
      expect.objectContaining({ error: "invalid_cursor", field: "cursor" })
    );
  });
});
