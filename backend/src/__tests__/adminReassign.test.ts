// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * HTTP-level tests for the manual reassignment endpoint added in issue #621:
 *   POST /api/admin/applications/:id/reassign
 */

import express from "express";
import request from "supertest";

const mockReviewerFindUnique = jest.fn();
const mockReviewerFindMany = jest.fn().mockResolvedValue([]);
const mockReviewerCreate = jest.fn();
const mockReviewerUpdate = jest.fn().mockResolvedValue({});
const mockAppFindFirst = jest.fn();
const mockAppUpdate = jest.fn().mockResolvedValue({});
const mockAuditCreate = jest.fn().mockResolvedValue({});
const mockTransaction = jest.fn(async (cb: any) => {
  const tx: any = {
    reviewer: { update: mockReviewerUpdate },
    loanApplication: { update: mockAppUpdate },
    auditLog: { create: mockAuditCreate },
  };
  return cb(tx);
});

jest.mock("../services/db.js", () => ({
  prisma: {
    reviewer: {
      findUnique: (...args: any[]) => mockReviewerFindUnique(...args),
      findMany: (...args: any[]) => mockReviewerFindMany(...args),
      create: (...args: any[]) => mockReviewerCreate(...args),
      update: (...args: any[]) => mockReviewerUpdate(...args),
    },
    loanApplication: {
      findFirst: (...args: any[]) => mockAppFindFirst(...args),
      update: (...args: any[]) => mockAppUpdate(...args),
    },
    auditLog: { create: (...args: any[]) => mockAuditCreate(...args) },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

jest.mock("../services/inviteCode.js", () => ({ promoteWaitlistBatch: jest.fn() }));
jest.mock("../services/loanStore.js", () => ({ bulkReviewApplications: jest.fn() }));
jest.mock("../services/webhook.js", () => ({ sendWebhook: jest.fn() }));
jest.mock("../jobs/escrowReconciliation.js", () => ({ runEscrowReconciliation: jest.fn() }));
jest.mock("../services/applicantMerge.js", () => ({
  mergeApplicants: jest.fn(),
  MergeValidationError: class MergeValidationError extends Error {},
}));
jest.mock("../services/suspiciousActivity.js", () => ({ runSuspiciousActivityScan: jest.fn() }));
jest.mock("../services/autoRejectionRuleStore.js", () => ({
  listAutoRejectionRules: jest.fn(),
  createAutoRejectionRule: jest.fn(),
  updateAutoRejectionRule: jest.fn(),
}));

jest.mock("../config.js", () => ({
  loadConfig: () => ({ adminApiKey: "test-admin-key" }),
}));

jest.mock("../middleware/auth.js", () => ({
  requireAdmin: (req: any, res: any, next: any) => {
    if (req.headers.authorization === "Bearer test-admin-key") {
      req.user = { walletAddress: "GADMIN", network: "testnet" };
      // `req.ip` is a getter-only property on the Express request.
      Object.defineProperty(req, "ip", { value: "127.0.0.1", configurable: true });
      return next();
    }
    return res.status(401).json({ error: "unauthorized" });
  },
}));

import { adminRouter } from "../routes/admin.js";

const app = express();
app.use(express.json());
app.use("/api/admin", adminRouter);

const ACTIVE_REVIEWER = { id: "rev-active", email: "active@example.com", status: "ACTIVE" };
const ON_LEAVE_REVIEWER = { id: "rev-away", email: "away@example.com", status: "ON_LEAVE" };
const APPLICATION = { id: "app-1", deletedAt: null, assignedReviewerId: null };

describe("POST /api/admin/applications/:id/reassign", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReviewerUpdate.mockResolvedValue({});
    mockAppUpdate.mockResolvedValue({});
    mockAuditCreate.mockResolvedValue({});
  });

  it("requires admin auth", async () => {
    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .send({ reviewerId: "rev-active" });
    expect(res.status).toBe(401);
  });

  it("rejects a request without reviewerId", async () => {
    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("reassigns to an active reviewer and audits the override", async () => {
    mockReviewerFindUnique.mockResolvedValue(ACTIVE_REVIEWER);
    mockAppFindFirst.mockResolvedValue(APPLICATION);

    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ applicationId: "app-1", reviewerId: "rev-active" });
    expect(mockAppUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "app-1" },
        data: expect.objectContaining({ assignedReviewerId: "rev-active" }),
      })
    );
    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: "loan_application.reassigned" }) })
    );
  });

  it("refuses to reassign to an inactive/on-leave reviewer", async () => {
    mockReviewerFindUnique.mockResolvedValue(ON_LEAVE_REVIEWER);
    mockAppFindFirst.mockResolvedValue(APPLICATION);

    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-away" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reviewer_inactive");
    expect(mockAppUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown reviewer", async () => {
    mockReviewerFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("reviewer_not_found");
  });

  it("returns 404 when the application does not exist", async () => {
    mockReviewerFindUnique.mockResolvedValue(ACTIVE_REVIEWER);
    mockAppFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/applications/missing/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("application_not_found");
  });
});
