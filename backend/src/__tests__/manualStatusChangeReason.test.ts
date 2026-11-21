// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Required reason codes on manual applicant status changes (issue #1102).
 *
 * Runs the real loan/admin routes, the real loan store and the real loan
 * history writer against in-memory Prisma tables, then reads the result back
 * through the real activity timeline — so "the reason appears in the
 * history" is checked end to end rather than against a mock call.
 */

import express from "express";
import request from "supertest";
import { loanRowFactory } from "../test-utils/factories/index.js";

const ADMIN_WALLET = "G" + "A".repeat(55);
const BORROWER_WALLET = "G" + "B".repeat(55);
process.env.ADMIN_WALLET_ADDRESS = ADMIN_WALLET;

type MockRow = Record<string, any>;
const mockLoans: Record<string, MockRow> = {};
const mockAudit: MockRow[] = [];

function seedLoan(overrides: MockRow = {}): MockRow {
  const base = loanRowFactory.build({
    id: "loan-1",
    applicantId: "applicant-1",
    applicant: { id: "applicant-1", stellarAddress: BORROWER_WALLET, deletedAt: null },
  });
  const row: MockRow = { ...base, status: "Pending", version: 1, updatedAt: base.createdAt, ...overrides };
  mockLoans[row.id] = row;
  return row;
}

const mockLoanFindFirst = jest.fn(async ({ where }: any = {}) => {
  const row = mockLoans[where?.id];
  if (!row) return null;
  if (where?.deletedAt === null && row.deletedAt) return null;
  return { ...row };
});

const mockLoanUpdate = jest.fn(async ({ where, data }: any) => {
  const row = mockLoans[where?.id];
  if (!row || (where?.version !== undefined && row.version !== where.version)) {
    throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
  }
  if (data?.version?.increment) row.version += data.version.increment;
  for (const key of ["status", "reason", "statusUpdatedAt", "lastActivityAt", "draftStaleNotifiedAt"]) {
    if (data?.[key] !== undefined) row[key] = data[key];
  }
  return { ...row };
});

let mockAuditSeq = 0;
const mockAuditCreate = jest.fn(async ({ data }: any) => {
  const row = { id: `audit-${++mockAuditSeq}`, createdAt: new Date(Date.UTC(2026, 10, 21, 0, 0, mockAuditSeq)), ...data };
  mockAudit.push(row);
  return row;
});

const mockAuditFindMany = jest.fn(async ({ where }: any) =>
  mockAudit
    .filter((row) => {
      if (where?.action?.in && !where.action.in.includes(row.action)) return false;
      const id = where?.metadata?.equals;
      return id === undefined || row.metadata?.applicationId === id;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
);

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findFirst: (...args: any[]) => mockLoanFindFirst(...args),
      update: (...args: any[]) => mockLoanUpdate(...args),
      findMany: jest.fn(async () => []),
    },
    applicant: { update: jest.fn(async () => ({})), findFirst: jest.fn(async () => null) },
    borrower: { findUnique: jest.fn(async () => null) },
    auditLog: {
      create: (...args: any[]) => mockAuditCreate(...args),
      findMany: (...args: any[]) => mockAuditFindMany(...args),
    },
    $transaction: jest.fn(async (cb: any) =>
      cb({
        loanApplication: { findFirst: mockLoanFindFirst, update: mockLoanUpdate },
        auditLog: { create: mockAuditCreate },
      })
    ),
  },
}));

// Review-stage timing, pricing, assignment and notifications are covered
// elsewhere; only the reason requirement is in scope here.
jest.mock("../services/loanReviewStages.js", () => ({
  transitionReviewStage: jest.fn().mockResolvedValue(undefined),
  recordStageEnter: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/rateSheet.js", () => ({ priceNewOffer: jest.fn().mockResolvedValue(null) }));
jest.mock("../services/assignmentQueue.js", () => ({
  autoAssignApplicationReviewer: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../services/notification.js", () => ({
  queueNotification: jest.fn().mockResolvedValue({ id: "notif-1" }),
}));
jest.mock("../services/offeringWatchlist.js", () => ({
  notifyWatchersOfOpenedOffering: jest.fn().mockResolvedValue(0),
}));
jest.mock("../jobs/kycExpiryReminder.js", () => ({
  hasExpiredKycDocuments: jest.fn().mockResolvedValue(false),
}));

import { prisma } from "../services/db.js";
import { loanRouter } from "../routes/loan.js";
import { updateApplication, bulkReviewApplications } from "../services/loanStore.js";
import { getLoanActivityTimeline } from "../services/loanActivityTimeline.js";
import {
  parseManualStatusChangeReason,
  MANUAL_STATUS_CHANGE_REASON_CODES,
} from "../services/manualStatusChangeReason.js";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  (req as any).user = { walletAddress: ADMIN_WALLET, network: "testnet" };
  next();
});
app.use("/api/loan", loanRouter);

async function history(loanId = "loan-1") {
  const timeline = await getLoanActivityTimeline(
    { id: loanId, borrowerAddress: BORROWER_WALLET },
    { prisma: prisma as any }
  );
  return timeline.events.filter((event) => event.type === "status_change");
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockLoans)) delete mockLoans[key];
  mockAudit.length = 0;
  mockAuditSeq = 0;
});

describe("parseManualStatusChangeReason", () => {
  it("accepts a code from the fixed list with an optional note", () => {
    expect(parseManualStatusChangeReason("DUPLICATE_APPLICATION")).toEqual({
      ok: true,
      reason: { code: "DUPLICATE_APPLICATION", label: MANUAL_STATUS_CHANGE_REASON_CODES.DUPLICATE_APPLICATION },
    });
    expect(parseManualStatusChangeReason("SUSPECTED_FRAUD", "  mismatched ID photo ")).toMatchObject({
      ok: true,
      reason: { code: "SUSPECTED_FRAUD", note: "mismatched ID photo" },
    });
  });

  it("rejects a missing, unknown or prototype-named code", () => {
    expect(parseManualStatusChangeReason(undefined)).toMatchObject({ ok: false, error: "missing_reason_code" });
    expect(parseManualStatusChangeReason("")).toMatchObject({ ok: false, error: "missing_reason_code" });
    expect(parseManualStatusChangeReason("BECAUSE")).toMatchObject({ ok: false, error: "invalid_reason_code" });
    expect(parseManualStatusChangeReason("toString")).toMatchObject({ ok: false, error: "invalid_reason_code" });
  });

  it("requires a note for OTHER and bounds the note length", () => {
    expect(parseManualStatusChangeReason("OTHER")).toMatchObject({ ok: false, error: "invalid_reason_note" });
    expect(parseManualStatusChangeReason("OTHER", "escalated by compliance")).toMatchObject({ ok: true });
    expect(parseManualStatusChangeReason("DATA_CORRECTION", "x".repeat(1001))).toMatchObject({
      ok: false,
      error: "invalid_reason_note",
    });
    expect(parseManualStatusChangeReason("DATA_CORRECTION", 42)).toMatchObject({ ok: false, error: "invalid_reason_note" });
  });
});

describe("POST /api/loan/:id/reject", () => {
  it("rejects a manual status change without a reason code and leaves the application untouched", async () => {
    seedLoan();

    const res = await request(app).post("/api/loan/loan-1/reject").send({ expectedVersion: 1, reason: "free text only" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "missing_reason_code", field: "reasonCode" });
    expect(mockLoanUpdate).not.toHaveBeenCalled();
    expect(mockLoans["loan-1"].status).toBe("Pending");
    expect(mockAudit).toHaveLength(0);
  });

  it("rejects a reason code that is not on the fixed list", async () => {
    seedLoan();
    const res = await request(app).post("/api/loan/loan-1/reject").send({ expectedVersion: 1, reasonCode: "VIBES" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_reason_code");
    expect(mockLoanUpdate).not.toHaveBeenCalled();
  });

  it("records the reason in the applicant's activity history alongside the status change", async () => {
    seedLoan();

    const res = await request(app)
      .post("/api/loan/loan-1/reject")
      .send({ expectedVersion: 1, reasonCode: "ELIGIBILITY_NOT_MET", reasonNote: "DTI above 45%" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "Rejected", reason: "Eligibility criteria not met: DTI above 45%" });

    expect(mockAudit).toHaveLength(1);
    expect(mockAudit[0]).toMatchObject({
      action: "loan_application.manual_status_change",
      actorAddress: ADMIN_WALLET,
      metadata: {
        applicationId: "loan-1",
        changes: { status: { from: "Pending", to: "Rejected" } },
        statusChangeReason: {
          code: "ELIGIBILITY_NOT_MET",
          label: "Eligibility criteria not met",
          note: "DTI above 45%",
        },
      },
    });

    const events = await history();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: "Rejected",
      actorAddress: ADMIN_WALLET,
      summary: "Status changed to Rejected — Eligibility criteria not met: DTI above 45%",
      metadata: {
        from: "Pending",
        to: "Rejected",
        reasonCode: "ELIGIBILITY_NOT_MET",
        reasonLabel: "Eligibility criteria not met",
        reasonNote: "DTI above 45%",
      },
    });
  });
});

describe("POST /api/loan/:id/review", () => {
  it("rejects a manual review decision without a reason code", async () => {
    seedLoan();
    const res = await request(app)
      .post("/api/loan/loan-1/review")
      .send({ reviewerId: "rev-1", decision: "REJECTED", expectedVersion: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_reason_code");
    expect(mockLoanUpdate).not.toHaveBeenCalled();
  });

  it("stores the reason with the status change", async () => {
    seedLoan({ status: "MANUAL_REVIEW" });

    const res = await request(app)
      .post("/api/loan/loan-1/review")
      .send({ reviewerId: "rev-1", decision: "APPROVED", expectedVersion: 1, reasonCode: "DOCUMENTATION_VERIFIED" });

    expect(res.status).toBe(200);
    const events = await history();
    expect(events[0]).toMatchObject({
      status: "Pending",
      metadata: { from: "MANUAL_REVIEW", reasonCode: "DOCUMENTATION_VERIFIED" },
    });
  });
});

describe("bulk review", () => {
  it("keeps the reason in each decision's audit entry", async () => {
    seedLoan();

    const { results } = await bulkReviewApplications(
      [
        {
          applicationId: "loan-1",
          decision: "reject",
          statusChangeReason: { code: "DUPLICATE_APPLICATION", label: "Duplicate application" },
        },
      ],
      ADMIN_WALLET
    );

    expect(results[0].status).toBe("Rejected");
    const events = await history();
    expect(events[0]).toMatchObject({
      status: "Rejected",
      summary: "Status changed to Rejected — Duplicate application",
      metadata: { reasonCode: "DUPLICATE_APPLICATION" },
    });
  });
});

describe("automated workflow status changes", () => {
  it("are unaffected: no reason is required and the audit entry stays a plain update", async () => {
    seedLoan({ status: "Approved" });

    // The Approved → Disbursing hop the approve flow performs on its own.
    const updated = await updateApplication("loan-1", { status: "Disbursing" });

    expect(updated?.status).toBe("Disbursing");
    expect(mockAudit).toHaveLength(1);
    expect(mockAudit[0].action).toBe("loan_application.updated");
    expect(mockAudit[0].metadata.statusChangeReason).toBeUndefined();

    const events = await history();
    expect(events[0]).toMatchObject({ status: "Disbursing", summary: "Status changed to Disbursing" });
    expect(events[0].metadata).toEqual({ from: "Approved", to: "Disbursing" });
  });
});
