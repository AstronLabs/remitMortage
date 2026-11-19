// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Optimistic locking on loan application records (issue #846).
 *
 * Exercises the real routes and the real loan store with persistence mocked,
 * so both layers of the guard are covered:
 *
 *   - decision endpoints require the `expectedVersion` token (400 when it is
 *     missing or malformed),
 *   - an update carrying the current version succeeds and increments it,
 *   - a stale update is rejected with 409 and the current state (both the
 *     fast-path read check and the atomic WHERE-clause race window),
 *   - bulk review reports per-item `version_conflict` failures.
 */

import express from "express";
import request from "supertest";
import { loanRowFactory } from "../test-utils/factories/index.js";

const ADMIN_WALLET = "G" + "A".repeat(55);
const BORROWER_WALLET = "G" + "B".repeat(55);
process.env.ADMIN_WALLET_ADDRESS = ADMIN_WALLET;

// ── In-memory loan rows standing in for the Prisma table ────────────────────

type MockRow = Record<string, any>;

const mockRows: Record<string, MockRow> = {};

function seedLoan(overrides: MockRow = {}): MockRow {
  const base = loanRowFactory.build({
    id: "loan-1",
    applicantId: "applicant-1",
    applicant: { id: "applicant-1", stellarAddress: BORROWER_WALLET },
  });
  // The loan mapper reads `updatedAt`, which is not a schema column.
  const row: MockRow = { ...base, updatedAt: base.createdAt, ...overrides };
  mockRows[row.id] = row;
  return row;
}

const mockLoanFindFirst = jest.fn(async ({ where }: any = {}) => {
  const row = mockRows[where?.id];
  if (!row) return null;
  if (where?.deletedAt === null && row.deletedAt) return null;
  return { ...row, applicant: row.applicant };
});

const mockLoanUpdate = jest.fn(async ({ where, data }: any) => {
  const row = mockRows[where?.id];
  // Mirrors Prisma's P2025: no row matched — either missing or the optimistic
  // guard (`where.version`) no longer holds because of a concurrent write.
  if (!row || (where?.version !== undefined && row.version !== where.version)) {
    throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
  }
  if (data?.version?.increment) row.version += data.version.increment;
  if (data?.status !== undefined) row.status = data.status;
  if (data?.reason !== undefined) row.reason = data.reason;
  if (data?.lastActivityAt !== undefined) row.lastActivityAt = data.lastActivityAt;
  if (data?.draftStaleNotifiedAt !== undefined) row.draftStaleNotifiedAt = data.draftStaleNotifiedAt;
  if (data?.deletedAt !== undefined) row.deletedAt = data.deletedAt;
  if (data?.statusUpdatedAt !== undefined) row.statusUpdatedAt = data.statusUpdatedAt;
  return { ...row, applicant: row.applicant };
});

const mockAuditCreate = jest.fn(async () => ({}));
const mockApplicantUpdate = jest.fn(async () => ({}));
const mockTransaction = jest.fn(async (cb: any) =>
  cb({
    loanApplication: { findFirst: mockLoanFindFirst, update: mockLoanUpdate },
    auditLog: { create: mockAuditCreate },
  })
);

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findFirst: (...args: any[]) => mockLoanFindFirst(...args),
      update: (...args: any[]) => mockLoanUpdate(...args),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async (args: any) => args?.data ?? {}),
    },
    applicant: {
      update: (...args: any[]) => mockApplicantUpdate(...args),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
    },
    auditLog: { create: (...args: any[]) => mockAuditCreate(...args) },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

jest.mock("../services/loanHistory.js", () => ({
  recordLoanCreation: jest.fn().mockResolvedValue(undefined),
  recordLoanChange: jest.fn().mockResolvedValue(undefined),
  diffLoanSnapshot: jest.fn(() => ({})),
  reconstructLoanApplicationAt: jest.fn().mockResolvedValue(null),
}));

// Pricing and assignment are covered elsewhere; only the version guard is in
// scope here.
jest.mock("../services/rateSheet.js", () => ({
  priceNewOffer: jest.fn().mockResolvedValue(null),
}));
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

// The module under test must be required after the mocks above are declared.
import { loanRouter } from "../routes/loan.js";
import {
  updateApplication,
  bulkReviewApplications,
  StaleVersionError,
} from "../services/loanStore.js";

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  // Stand in for authMiddleware: every caller is the operator admin wallet,
  // which is what requireLoanAdmin demands for decision endpoints.
  (req as any).user = { walletAddress: ADMIN_WALLET, network: "testnet" };
  next();
});
app.use("/api/loan", loanRouter);

/** Lets outstanding microtasks (fire-and-forget follow-up writes) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockRows)) delete mockRows[key];
});

describe("POST /api/loan/:id/approve — expectedVersion is required", () => {
  beforeEach(() => seedLoan({ version: 3 }));

  it("rejects a decision sent without the version token", async () => {
    const res = await request(app).post("/api/loan/loan-1/approve").send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_field");
    expect(res.body.field).toBe("expectedVersion");
    expect(mockLoanUpdate).not.toHaveBeenCalled();
    expect(mockRows["loan-1"].version).toBe(3);
  });

  it.each([["2"], [0], [1.5], [null], [undefined]])(
    "rejects malformed version token %p",
    async (token) => {
      const res = await request(app)
        .post("/api/loan/loan-1/approve")
        .send({ expectedVersion: token });

      expect(res.status).toBe(400);
      expect(res.body.field).toBe("expectedVersion");
      expect(mockLoanUpdate).not.toHaveBeenCalled();
    }
  );
});

describe("POST /api/loan/:id/approve — stale decision is a 409 with current state", () => {
  it("returns the record as it stands now when the caller's version is behind", async () => {
    seedLoan({ version: 5, status: "Approved" });

    const res = await request(app)
      .post("/api/loan/loan-1/approve")
      .send({ expectedVersion: 4 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("version_conflict");
    expect(res.body.expectedVersion).toBe(4);
    expect(res.body.currentVersion).toBe(5);
    expect(res.body.application).toMatchObject({
      id: "loan-1",
      version: 5,
      status: "Approved",
    });
    // Nothing was written — the stale decision never reached the record.
    expect(mockLoanUpdate).not.toHaveBeenCalled();
    expect(mockRows["loan-1"].status).toBe("Approved");
    expect(mockRows["loan-1"].version).toBe(5);
  });

  it("rejects with 409 when the record changes between the read and the write", async () => {
    const row = seedLoan({ version: 3 });

    // First read (ownership/admin gate) sees version 3 — the route check
    // passes — but a concurrent reviewer lands before updateApplication's own
    // read, which now sees version 4. The store must surface a conflict.
    mockLoanFindFirst
      .mockResolvedValueOnce({ ...row, applicant: row.applicant })
      .mockResolvedValueOnce({ ...row, version: 4, status: "Rejected", applicant: row.applicant });

    const res = await request(app)
      .post("/api/loan/loan-1/approve")
      .send({ expectedVersion: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("version_conflict");
    expect(res.body.currentVersion).toBe(4);
    expect(res.body.application.status).toBe("Rejected");
    expect(mockLoanUpdate).not.toHaveBeenCalled();
  });
});

describe("POST /api/loan/:id/approve — current version succeeds", () => {
  it("applies the decision guarded on the version and increments it", async () => {
    const row = seedLoan({ version: 3 });

    const res = await request(app)
      .post("/api/loan/loan-1/approve")
      .send({ expectedVersion: 3 });

    expect(res.status).toBe(200);

    // First write is the approval, guarded atomically on the caller's version.
    expect(mockLoanUpdate.mock.calls[0][0]).toMatchObject({
      where: { id: "loan-1", version: 3 },
      data: { status: "Approved", version: { increment: 1 } },
    });

    // Let the fire-and-forget follow-up Disbursing write settle before
    // asserting on the final state.
    await flush();
    expect(mockLoanUpdate).toHaveBeenCalledTimes(2);
    // Version moved 3 → 4 (approval) → 5 (the follow-up Disbursing write).
    expect(mockRows["loan-1"].version).toBe(5);
    expect(mockRows["loan-1"].status).toBe("Disbursing");
    expect(row.status).toBe("Disbursing");
  });
});

describe("POST /api/loan/:id/reject and /:id/review", () => {
  it("reject requires the token and 409s when stale", async () => {
    seedLoan({ version: 7 });

    const missing = await request(app).post("/api/loan/loan-1/reject").send({ reason: "x" });
    expect(missing.status).toBe(400);
    expect(missing.body.field).toBe("expectedVersion");

    const stale = await request(app)
      .post("/api/loan/loan-1/reject")
      .send({ reason: "x", expectedVersion: 6 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: "version_conflict",
      expectedVersion: 6,
      currentVersion: 7,
    });
    expect(stale.body.application.version).toBe(7);
    expect(mockLoanUpdate).not.toHaveBeenCalled();
  });

  it("review applies with the current version and returns the incremented record", async () => {
    seedLoan({ version: 2 });

    const res = await request(app)
      .post("/api/loan/loan-1/review")
      .send({ reviewerId: "rev-1", decision: "APPROVED", expectedVersion: 2 });

    expect(res.status).toBe(200);
    expect(res.body.application.version).toBe(3);
    expect(mockRows["loan-1"].version).toBe(3);
    expect(mockLoanUpdate.mock.calls[0][0].where).toEqual({ id: "loan-1", version: 2 });
  });

  it("review 409s when another reviewer already decided", async () => {
    seedLoan({ version: 9, status: "Rejected" });

    const res = await request(app)
      .post("/api/loan/loan-1/review")
      .send({ reviewerId: "rev-2", decision: "APPROVED", expectedVersion: 8 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("version_conflict");
    expect(res.body.application).toMatchObject({ status: "Rejected", version: 9 });
    expect(mockLoanUpdate).not.toHaveBeenCalled();
  });
});

describe("updateApplication — service-level version semantics", () => {
  it("an update with the current version succeeds and increments it", async () => {
    const row = seedLoan({ version: 4 });

    const updated = await updateApplication("loan-1", { status: "Approved" }, { expectedVersion: 4 });

    expect(updated).not.toBeNull();
    expect(updated!.version).toBe(5);
    expect(mockRows["loan-1"].version).toBe(5);
    expect(mockLoanUpdate.mock.calls[0][0].where).toEqual({ id: "loan-1", version: 4 });
    expect(mockLoanUpdate.mock.calls[0][0].data.version).toEqual({ increment: 1 });
    expect(row.status).toBe("Approved");
  });

  it("throws StaleVersionError carrying the current state when behind", async () => {
    seedLoan({ version: 6, status: "Rejected" });

    await expect(
      updateApplication("loan-1", { status: "Approved" }, { expectedVersion: 5 })
    ).rejects.toMatchObject({
      name: "StaleVersionError",
      code: "version_conflict",
      expectedVersion: 5,
      current: expect.objectContaining({ version: 6, status: "Rejected" }),
    });
    expect(mockLoanUpdate).not.toHaveBeenCalled();
    expect(mockRows["loan-1"].status).toBe("Rejected");
  });

  it("is an instance of StaleVersionError so routes can branch on it", async () => {
    seedLoan({ version: 6 });

    const attempt = updateApplication("loan-1", { status: "Approved" }, { expectedVersion: 5 });
    await expect(attempt).rejects.toBeInstanceOf(StaleVersionError);
  });

  it("still increments the token for internal callers that send no version", async () => {
    seedLoan({ version: 1 });

    const updated = await updateApplication("loan-1", { status: "MANUAL_REVIEW" });

    expect(updated!.version).toBe(2);
    // Unguarded internal write: WHERE carries only the primary key.
    expect(mockLoanUpdate.mock.calls[0][0].where).toEqual({ id: "loan-1" });
  });

  it("translates a lost race on the guarded UPDATE (P2025) into a 409 conflict", async () => {
    seedLoan({ version: 3 });

    // The read sees the expected version, but the guarded UPDATE misses
    // because a concurrent writer bumped the row first; the recovery read
    // then shows version 4.
    mockLoanUpdate.mockRejectedValueOnce(
      Object.assign(new Error("Record to update not found."), { code: "P2025" })
    );
    mockLoanFindFirst.mockResolvedValueOnce({
      ...mockRows["loan-1"],
      version: 4,
      applicant: mockRows["loan-1"].applicant,
    });

    await expect(
      updateApplication("loan-1", { status: "Approved" }, { expectedVersion: 3 })
    ).rejects.toMatchObject({
      name: "StaleVersionError",
      expectedVersion: 3,
      current: expect.objectContaining({ version: 4 }),
    });
    // The guarded write was attempted but landed nothing on the record.
    expect(mockLoanUpdate).toHaveBeenCalledTimes(1);
    expect(mockRows["loan-1"].version).toBe(3);
    expect(mockRows["loan-1"].status).toBe("Pending");
  });
});

describe("bulkReviewApplications — per-item version guard", () => {
  it("reports a stale item as version_conflict with its current state", async () => {
    seedLoan({ version: 4, status: "Pending" });

    const { results, failures } = await bulkReviewApplications(
      [{ applicationId: "loan-1", decision: "approve", version: 3 }],
      ADMIN_WALLET,
      "127.0.0.1"
    );

    expect(results).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      applicationId: "loan-1",
      error: "version_conflict",
      currentVersion: 4,
    });
    expect(failures[0].application).toMatchObject({ id: "loan-1", version: 4 });
    expect(mockLoanUpdate).not.toHaveBeenCalled();
    expect(mockRows["loan-1"].status).toBe("Pending");
  });

  it("applies an item carrying the current version and echoes the incremented one", async () => {
    seedLoan({ version: 4, status: "Pending" });

    const { results, failures } = await bulkReviewApplications(
      [{ applicationId: "loan-1", decision: "approve", version: 4 }],
      ADMIN_WALLET,
      "127.0.0.1"
    );

    expect(failures).toHaveLength(0);
    expect(results).toEqual([
      { applicationId: "loan-1", decision: "approve", status: "Approved", version: 5 },
    ]);
    expect(mockLoanUpdate.mock.calls[0][0].where).toEqual({ id: "loan-1", version: 4 });
    expect(mockLoanUpdate.mock.calls[0][0].data.version).toEqual({ increment: 1 });
    expect(mockRows["loan-1"].version).toBe(5);
  });

  it("keeps legacy items without a version working (batch backward compatibility)", async () => {
    seedLoan({ version: 1, status: "Pending" });

    const { results, failures } = await bulkReviewApplications(
      [{ applicationId: "loan-1", decision: "reject", reason: "legacy caller" }],
      ADMIN_WALLET,
      "127.0.0.1"
    );

    expect(failures).toHaveLength(0);
    expect(results[0].status).toBe("Rejected");
    expect(mockRows["loan-1"].version).toBe(2);
  });
});
