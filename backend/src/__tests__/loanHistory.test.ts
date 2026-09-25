// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  diffLoanSnapshot,
  reconstructLoanApplicationAt,
  LOAN_CREATED_ACTION,
  LOAN_UPDATED_ACTION,
  type LoanSnapshot,
} from "../services/loanHistory.js";
import { prisma } from "../services/db.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: { findFirst: jest.fn() },
    auditLog: { findMany: jest.fn() },
  },
}));

const findFirst = prisma.loanApplication.findFirst as jest.Mock;
const findMany = prisma.auditLog.findMany as jest.Mock;

const BORROWER = "GA" + "A".repeat(54);

// A synthetic audit trail for one application. `reconstructLoanApplicationAt`
// relies on the DB to apply the `createdAt <= asOf` filter and the ordering,
// so the mock below reproduces both.
interface FakeEntry {
  action: string;
  createdAt: Date;
  metadata: Record<string, unknown>;
}

const CREATED_AT = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-05T12:00:00.000Z");
const T2 = new Date("2026-01-10T09:30:00.000Z");
const T3 = new Date("2026-01-20T18:15:00.000Z");

const CREATION_SNAPSHOT: LoanSnapshot = {
  borrowerAddress: BORROWER,
  amount: 1000 as unknown as string,
  status: "Pending",
  reason: undefined,
};

const TRAIL: FakeEntry[] = [
  {
    action: LOAN_CREATED_ACTION,
    createdAt: CREATED_AT,
    metadata: { applicationId: "loan-1", snapshot: CREATION_SNAPSHOT },
  },
  {
    action: LOAN_UPDATED_ACTION,
    createdAt: T1,
    metadata: {
      applicationId: "loan-1",
      changes: { amount: { from: 1000, to: 1500 } },
    },
  },
  {
    action: LOAN_UPDATED_ACTION,
    createdAt: T2,
    metadata: {
      applicationId: "loan-1",
      changes: { status: { from: "Pending", to: "Approved" } },
    },
  },
  {
    action: "loan_application.bulk_approved",
    createdAt: T3,
    metadata: {
      applicationId: "loan-1",
      changes: {
        status: { from: "Approved", to: "Disbursing" },
        reason: { from: null, to: "funds released" },
      },
    },
  },
];

beforeEach(() => {
  jest.clearAllMocks();

  findFirst.mockResolvedValue({
    id: "loan-1",
    createdAt: CREATED_AT,
    applicant: { stellarAddress: BORROWER },
    principal: 1500,
    status: "Disbursing",
    reason: "funds released",
  });

  findMany.mockImplementation(async ({ where }: any) => {
    const asOf: Date = where.createdAt.lte;
    return TRAIL.filter(
      (e) =>
        e.createdAt.getTime() <= asOf.getTime() &&
        (e.metadata.applicationId as string) === where.metadata.equals,
    ).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  });
});

describe("diffLoanSnapshot", () => {
  const base: LoanSnapshot = {
    borrowerAddress: BORROWER,
    amount: 1000 as unknown as string,
    status: "Pending",
    reason: undefined,
  };

  it("returns an empty change set when nothing tracked changed", () => {
    expect(diffLoanSnapshot(base, { ...base })).toEqual({});
  });

  it("records only the fields that actually changed, with from/to", () => {
    const after: LoanSnapshot = { ...base, status: "Approved", reason: "ok" };
    expect(diffLoanSnapshot(base, after)).toEqual({
      status: { from: "Pending", to: "Approved" },
      reason: { from: undefined, to: "ok" },
    });
  });
});

describe("reconstructLoanApplicationAt", () => {
  it("returns null when asOf predates the application's creation", async () => {
    const before = new Date(CREATED_AT.getTime() - 1000);
    expect(await reconstructLoanApplicationAt("loan-1", before)).toBeNull();
  });

  it("returns null for an unknown application", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(
      await reconstructLoanApplicationAt("missing", new Date()),
    ).toBeNull();
  });

  it("returns the creation snapshot at the creation instant", async () => {
    const state = await reconstructLoanApplicationAt("loan-1", CREATED_AT);
    expect(state).toMatchObject({
      id: "loan-1",
      borrowerAddress: BORROWER,
      amount: 1000,
      status: "Pending",
      updatedAt: CREATED_AT.toISOString(),
    });
    expect(state?.reason).toBeUndefined();
  });

  it("replays changes up to a mid-history checkpoint and no further", async () => {
    const between = new Date("2026-01-07T00:00:00.000Z"); // after T1, before T2
    const state = await reconstructLoanApplicationAt("loan-1", between);
    expect(state).toMatchObject({
      amount: 1500, // T1 applied
      status: "Pending", // T2 not yet applied
      updatedAt: T1.toISOString(),
    });
  });

  it("matches the record exactly at a known checkpoint (T2)", async () => {
    const state = await reconstructLoanApplicationAt("loan-1", T2);
    expect(state).toMatchObject({
      amount: 1500,
      status: "Approved",
      updatedAt: T2.toISOString(),
    });
  });

  it("applies bulk-review transitions too, reaching current state after the last event", async () => {
    const after = new Date("2026-02-01T00:00:00.000Z");
    const state = await reconstructLoanApplicationAt("loan-1", after);
    expect(state).toMatchObject({
      amount: 1500,
      status: "Disbursing",
      reason: "funds released",
      updatedAt: T3.toISOString(),
    });
  });

  it("falls back to the provided seed for a legacy loan with no creation event", async () => {
    findMany.mockResolvedValueOnce([
      {
        action: LOAN_UPDATED_ACTION,
        createdAt: T1,
        metadata: {
          applicationId: "loan-1",
          changes: { status: { from: "Pending", to: "Rejected" } },
        },
      },
    ]);
    const state = await reconstructLoanApplicationAt("loan-1", T2, {
      fallbackSeed: {
        borrowerAddress: BORROWER,
        amount: 2000 as unknown as string,
        status: "Pending",
        reason: undefined,
      },
    });
    expect(state).toMatchObject({
      amount: 2000, // from the seed
      status: "Rejected", // replayed change still applied
      updatedAt: T1.toISOString(),
    });
  });

  it("returns null for a legacy loan when no seed is supplied", async () => {
    findMany.mockResolvedValueOnce([]);
    expect(await reconstructLoanApplicationAt("loan-1", T2)).toBeNull();
  });
});
