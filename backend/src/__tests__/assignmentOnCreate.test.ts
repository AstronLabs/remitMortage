// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Integration test for issue #621: creating a loan application (the submission
 * path) must auto-assign it round-robin across active reviewers, and must never
 * fail when no reviewer is available.
 */

import { StrKey } from "@stellar/stellar-sdk";

const mockApplicantUpsert = jest.fn();
const mockAppCreate = jest.fn();
const mockAppUpdate = jest.fn().mockResolvedValue({});
const mockReviewerUpdate = jest.fn().mockResolvedValue({});
const mockReviewerFindMany = jest.fn();
const mockTransaction = jest.fn(async (cb: any) =>
  cb({ reviewer: { update: mockReviewerUpdate }, loanApplication: { update: mockAppUpdate } })
);

jest.mock("../services/db.js", () => ({
  prisma: {
    applicant: { upsert: (...args: any[]) => mockApplicantUpsert(...args) },
    loanApplication: {
      create: (...args: any[]) => mockAppCreate(...args),
      update: (...args: any[]) => mockAppUpdate(...args),
    },
    reviewer: { findMany: (...args: any[]) => mockReviewerFindMany(...args) },
    $transaction: (...args: any[]) => mockTransaction(...args),
  },
}));

jest.mock("../services/loanHistory.js", () => ({
  recordLoanCreation: jest.fn().mockResolvedValue(undefined),
  recordLoanChange: jest.fn().mockResolvedValue(undefined),
  diffLoanSnapshot: jest.fn(),
}));

import { createApplication } from "../services/loanStore.js";

const ADDRESS = StrKey.encodeEd25519PublicKey(Buffer.alloc(32));

const ACTIVE = { id: "rev-a", email: "a@example.com", status: "ACTIVE", lastAssignedAt: null };
const INACTIVE = { id: "rev-x", email: "x@example.com", status: "INACTIVE", lastAssignedAt: null };
const ON_LEAVE = { id: "rev-y", email: "y@example.com", status: "ON_LEAVE", lastAssignedAt: null };

function poolFor(...reviewers: any[]) {
  mockReviewerFindMany.mockImplementation(async ({ where }: any = {}) =>
    reviewers.filter((r) => !where?.status || r.status === where.status)
  );
}

describe("createApplication auto-assignment (issue #621)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReviewerUpdate.mockResolvedValue({});
    mockAppUpdate.mockResolvedValue({});
    mockApplicantUpsert.mockResolvedValue({ id: "applicant-1", stellarAddress: ADDRESS });
    mockAppCreate.mockImplementation(async ({ data }: any) => ({
      ...data,
      createdAt: new Date("2026-09-26T00:00:00.000Z"),
      applicant: { stellarAddress: ADDRESS },
    }));
    mockTransaction.mockImplementation(async (cb: any) =>
      cb({ reviewer: { update: mockReviewerUpdate }, loanApplication: { update: mockAppUpdate } })
    );
  });

  it("assigns the new application to an active reviewer", async () => {
    poolFor(ACTIVE, INACTIVE, ON_LEAVE);

    const app = await createApplication(ADDRESS, "1500");

    expect(mockReviewerFindMany).toHaveBeenCalledWith({ where: { status: "ACTIVE" } });
    expect(mockAppUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: app.id },
        data: expect.objectContaining({
          assignedReviewerId: "rev-a",
          assignedReviewerEmail: "a@example.com",
        }),
      })
    );
  });

  it("rotates to the least-recently-assigned reviewer on subsequent submissions", async () => {
    const a = { ...ACTIVE, lastAssignedAt: new Date("2026-09-26T10:00:00Z") };
    const b = { ...INACTIVE, id: "rev-b", email: "b@example.com", status: "ACTIVE", lastAssignedAt: null };
    poolFor(a, b);

    await createApplication(ADDRESS, "1500");

    expect(mockAppUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ assignedReviewerId: "rev-b" }) })
    );
  });

  it("still creates the application when there are no active reviewers", async () => {
    poolFor(INACTIVE, ON_LEAVE);

    const app = await createApplication(ADDRESS, "1500");

    expect(app.id).toBeDefined();
    expect(mockAppUpdate).not.toHaveBeenCalled();
  });
});
