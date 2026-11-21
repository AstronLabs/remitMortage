// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * HTTP-level tests for the manual reassignment endpoint added in issue #621
 * and the reviewer handoff flow added in issue #1101:
 *   POST /api/admin/applications/:id/reassign
 *   GET  /api/admin/applications/:id/handoff
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
const mockAuditFindMany = jest.fn().mockResolvedValue([]);
const mockGetLoanActivityTimeline = jest.fn();
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
    auditLog: {
      create: (...args: any[]) => mockAuditCreate(...args),
      findMany: (...args: any[]) => mockAuditFindMany(...args),
    },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

jest.mock("../services/loanActivityTimeline.js", () => ({
  getLoanActivityTimeline: (...args: any[]) => mockGetLoanActivityTimeline(...args),
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
const HANDED_OFF_APPLICATION = {
  id: "app-1",
  deletedAt: null,
  assignedReviewerId: "rev-old",
  assignedReviewerEmail: "old@example.com",
};
const NOTE = "Income docs verified; waiting on updated bank statement from applicant.";

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
      .send({ reviewerId: "rev-active", handoffNote: NOTE });
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
      .send({ reviewerId: "rev-active", handoffNote: NOTE });

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
      .send({ reviewerId: "rev-away", handoffNote: NOTE });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("reviewer_inactive");
    expect(mockAppUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown reviewer", async () => {
    mockReviewerFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "ghost", handoffNote: NOTE });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("reviewer_not_found");
  });

  it("returns 404 when the application does not exist", async () => {
    mockReviewerFindUnique.mockResolvedValue(ACTIVE_REVIEWER);
    mockAppFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/admin/applications/missing/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active", handoffNote: NOTE });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("application_not_found");
  });

  it("rejects a reassignment without a handoff note", async () => {
    mockReviewerFindUnique.mockResolvedValue(ACTIVE_REVIEWER);
    mockAppFindFirst.mockResolvedValue(HANDED_OFF_APPLICATION);

    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("handoff_note_required");
    expect(mockAppUpdate).not.toHaveBeenCalled();
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only handoff note", async () => {
    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active", handoffNote: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("handoff_note_required");
    expect(mockAppUpdate).not.toHaveBeenCalled();
  });

  it("rejects an overly long handoff note", async () => {
    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active", handoffNote: "x".repeat(2001) });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("handoff_note_too_long");
  });

  it("records the handoff note in the audit trail", async () => {
    mockReviewerFindUnique.mockResolvedValue(ACTIVE_REVIEWER);
    mockAppFindFirst.mockResolvedValue(HANDED_OFF_APPLICATION);

    const res = await request(app)
      .post("/api/admin/applications/app-1/reassign")
      .set("Authorization", "Bearer test-admin-key")
      .send({ reviewerId: "rev-active", handoffNote: `  ${NOTE}  ` });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ previousReviewerId: "rev-old", handoffNote: NOTE });
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "loan_application.reassigned",
        metadata: expect.objectContaining({
          applicationId: "app-1",
          reviewerId: "rev-active",
          previousReviewerId: "rev-old",
          previousReviewerEmail: "old@example.com",
          handoffNote: NOTE,
        }),
      }),
    });
  });
});

describe("GET /api/admin/applications/:id/handoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires admin auth", async () => {
    const res = await request(app).get("/api/admin/applications/app-1/handoff");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the application does not exist", async () => {
    mockAppFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/api/admin/applications/missing/handoff")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("application_not_found");
  });

  it("shows the new reviewer the handoff note alongside prior history", async () => {
    mockAppFindFirst.mockResolvedValue({
      id: "app-1",
      deletedAt: null,
      assignedReviewerId: "rev-active",
      assignedReviewerEmail: "active@example.com",
      applicant: { stellarAddress: "GBORROWER" },
    });
    mockAuditFindMany.mockResolvedValue([
      {
        id: "audit-2",
        actorAddress: "GADMIN",
        createdAt: new Date("2026-03-02T00:00:00.000Z"),
        metadata: {
          applicationId: "app-1",
          reviewerId: "rev-active",
          reviewerEmail: "active@example.com",
          previousReviewerId: "rev-old",
          previousReviewerEmail: "old@example.com",
          handoffNote: NOTE,
        },
      },
    ]);
    const priorStatusChange = {
      id: "status:s1",
      type: "status_change",
      occurredAt: "2026-03-01T00:00:00.000Z",
      summary: "Status changed to UnderReview",
      source: "loan_application.updated",
    };
    mockGetLoanActivityTimeline.mockResolvedValue({
      loanId: "app-1",
      events: [priorStatusChange],
      pagination: { limit: 20, cursor: null, nextCursor: null, hasNextPage: false },
    });

    const res = await request(app)
      .get("/api/admin/applications/app-1/handoff")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.latestHandoff).toMatchObject({
      fromReviewerId: "rev-old",
      toReviewerId: "rev-active",
      note: NOTE,
    });
    expect(res.body.handoffs).toHaveLength(1);
    expect(res.body.history).toEqual([priorStatusChange]);
    expect(mockAuditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: "loan_application.reassigned" }),
      })
    );
    expect(mockGetLoanActivityTimeline).toHaveBeenCalledWith(
      { id: "app-1", borrowerAddress: "GBORROWER" },
      expect.objectContaining({ includeInternalNotes: true })
    );
  });
});
