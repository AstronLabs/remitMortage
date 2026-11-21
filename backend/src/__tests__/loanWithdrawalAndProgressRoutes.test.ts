// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Route layer for applicant withdrawal (issue #1107) and server-side
 * application progress (issue #1110). Mounts the real loan router and the
 * real ownership gate, mocking only the loan store and the progress table.
 */

import express from "express";
import request from "supertest";
import { loanFactory } from "../test-utils/factories/index.js";

const ADMIN_WALLET = "G" + "A".repeat(55);
const OWNER_WALLET = "G" + "B".repeat(55);
const OTHER_WALLET = "G" + "C".repeat(55);
process.env.ADMIN_WALLET_ADDRESS = ADMIN_WALLET;

/** In-memory ApplicationProgress table, shared by every "device". */
const mockProgressRows = new Map<string, any>();

jest.mock("../services/loanStore.js", () => ({
  createApplication: jest.fn(),
  getApplication: jest.fn(),
  getApplicationsByBorrower: jest.fn(),
  getPendingApplications: jest.fn(),
  updateApplication: jest.fn(),
  resumeDraftApplication: jest.fn(),
  discardDraftApplication: jest.fn(),
  withdrawApplication: jest.fn(),
  getReviewQueueMetrics: jest.fn(),
  MAX_WITHDRAWAL_REASON_LENGTH: 500,
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
jest.mock("../services/db.js", () => ({
  prisma: {
    applicationProgress: {
      findUnique: jest.fn(async ({ where }: any) => mockProgressRows.get(where.stellarAddress) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = mockProgressRows.get(where.stellarAddress);
        const row = existing
          ? { ...existing, ...update, updatedAt: new Date() }
          : { ...create, createdAt: new Date(), updatedAt: new Date() };
        mockProgressRows.set(where.stellarAddress, row);
        return row;
      }),
      deleteMany: jest.fn(async ({ where }: any) => ({
        count: mockProgressRows.delete(where.stellarAddress) ? 1 : 0,
      })),
    },
  },
}));
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
jest.mock("../services/loanActivityTimeline.js", () => ({
  InvalidActivityCursorError: class extends Error {},
  getLoanActivityTimeline: jest.fn(),
}));

import { loanRouter } from "../routes/loan.js";
import { getApplication, getReviewQueueMetrics, withdrawApplication } from "../services/loanStore.js";

const getApplicationMock = getApplication as jest.Mock;
const withdrawMock = withdrawApplication as jest.Mock;
const metricsMock = getReviewQueueMetrics as jest.Mock;

const LOAN = loanFactory.build({ id: "loan-1", borrowerAddress: OWNER_WALLET, status: "Pending" });

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

beforeEach(() => {
  jest.clearAllMocks();
  mockProgressRows.clear();
  getApplicationMock.mockResolvedValue(LOAN);
});

describe("POST /api/loan/:id/withdraw", () => {
  it("withdraws the applicant's own pending application with a trimmed reason", async () => {
    withdrawMock.mockResolvedValue({
      ok: true,
      application: { ...LOAN, status: "Withdrawn", withdrawalReason: "Changed plans" },
    });

    const res = await request(ownerApp).post("/api/loan/loan-1/withdraw").send({ reason: "  Changed plans " });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("Withdrawn");
    expect(withdrawMock).toHaveBeenCalledWith("loan-1", "Changed plans");
  });

  it("treats the reason as optional", async () => {
    withdrawMock.mockResolvedValue({ ok: true, application: { ...LOAN, status: "Withdrawn" } });

    const res = await request(ownerApp).post("/api/loan/loan-1/withdraw").send({});

    expect(res.status).toBe(200);
    expect(withdrawMock).toHaveBeenCalledWith("loan-1", undefined);
  });

  it("409s a second withdrawal", async () => {
    withdrawMock.mockResolvedValue({
      ok: false,
      error: "already_withdrawn",
      current: { ...LOAN, status: "Withdrawn" },
    });

    const res = await request(ownerApp).post("/api/loan/loan-1/withdraw").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_withdrawn");
    expect(res.body.current.status).toBe("Withdrawn");
  });

  it("409s a withdrawal after a final decision", async () => {
    withdrawMock.mockResolvedValue({ ok: false, error: "final_decision", current: { ...LOAN, status: "Approved" } });

    const res = await request(ownerApp).post("/api/loan/loan-1/withdraw").send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("final_decision");
  });

  it("rejects a non-string or overlong reason", async () => {
    const badType = await request(ownerApp).post("/api/loan/loan-1/withdraw").send({ reason: 42 });
    const tooLong = await request(ownerApp).post("/api/loan/loan-1/withdraw").send({ reason: "x".repeat(501) });

    expect(badType.status).toBe(400);
    expect(tooLong.status).toBe(400);
    expect(withdrawMock).not.toHaveBeenCalled();
  });

  it("401s anonymous callers and 403s other wallets and admins", async () => {
    expect((await request(anonApp).post("/api/loan/loan-1/withdraw").send({})).status).toBe(401);
    expect((await request(otherApp).post("/api/loan/loan-1/withdraw").send({})).status).toBe(403);
    expect((await request(adminApp).post("/api/loan/loan-1/withdraw").send({})).status).toBe(403);
    expect(withdrawMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/loan/queue-metrics", () => {
  it("returns queue counts to admins only", async () => {
    metricsMock.mockResolvedValue({ activeQueue: 3, withdrawn: 1 });

    const admin = await request(adminApp).get("/api/loan/queue-metrics");
    const owner = await request(ownerApp).get("/api/loan/queue-metrics");

    expect(admin.status).toBe(200);
    expect(admin.body).toEqual({ activeQueue: 3, withdrawn: 1 });
    expect(owner.status).toBe(403);
  });
});

describe("/api/loan/progress", () => {
  const DATA = { recipientAddress: OTHER_WALLET, savingsTarget: 25_000, savingsDuration: 9, firstDepositAmount: 0 };

  it("persists progress across sessions and returns it on a different device", async () => {
    const saved = await request(ownerApp).put("/api/loan/progress").send({ step: 3, totalSteps: 5, data: DATA });
    expect(saved.status).toBe(200);

    // A fresh app instance stands in for another device signed in as the same wallet.
    const otherDevice = makeApp({ walletAddress: OWNER_WALLET, network: "testnet" });
    const resumed = await request(otherDevice).get("/api/loan/progress");

    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ step: 3, totalSteps: 5, data: DATA });
  });

  it("keeps the latest step as the applicant moves between steps", async () => {
    await request(ownerApp).put("/api/loan/progress").send({ step: 2, totalSteps: 5, data: DATA });
    await request(ownerApp)
      .put("/api/loan/progress")
      .send({ step: 4, totalSteps: 5, data: { ...DATA, savingsTarget: 30_000 } });

    const res = await request(ownerApp).get("/api/loan/progress");

    expect(res.body.step).toBe(4);
    expect(res.body.data.savingsTarget).toBe(30_000);
  });

  it("scopes progress to the authenticated wallet", async () => {
    await request(ownerApp).put("/api/loan/progress").send({ step: 3, totalSteps: 5, data: DATA });

    expect((await request(otherApp).get("/api/loan/progress")).status).toBe(404);
    expect((await request(anonApp).get("/api/loan/progress")).status).toBe(401);
    expect((await request(anonApp).put("/api/loan/progress").send({ step: 1, totalSteps: 5, data: {} })).status).toBe(
      401
    );
  });

  it("clears progress", async () => {
    await request(ownerApp).put("/api/loan/progress").send({ step: 3, totalSteps: 5, data: DATA });

    expect((await request(ownerApp).delete("/api/loan/progress")).status).toBe(204);
    expect((await request(ownerApp).get("/api/loan/progress")).status).toBe(404);
  });

  it.each([
    [{ step: 0, totalSteps: 5, data: {} }, "step"],
    [{ step: 6, totalSteps: 5, data: {} }, "step"],
    [{ step: 1, totalSteps: 99, data: {} }, "totalSteps"],
    [{ step: 1, totalSteps: 5, data: [] }, "data"],
    [{ step: 1, totalSteps: 5, data: { blob: "x".repeat(17 * 1024) } }, "data"],
  ])("400s invalid progress %#", async (body, field) => {
    const res = await request(ownerApp).put("/api/loan/progress").send(body);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "invalid_progress", field });
  });
});
