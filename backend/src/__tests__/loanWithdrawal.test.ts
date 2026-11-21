// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Applicant withdrawal (issue #1107) — service layer.
 *
 * Runs the real `withdrawApplication`, `getPendingApplications` and
 * `getReviewQueueMetrics` against a small in-memory stand-in for the
 * `loanApplication` table, so a withdrawal is observed leaving the active
 * review queue exactly as the queue queries see it.
 */

type Row = Record<string, any>;

const mockRows: Row[] = [];

function mockMatches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === "applicant") return true;
    return (row[key] ?? null) === value;
  });
}

function mockWithApplicant(row: Row): Row {
  return { ...row, applicant: { stellarAddress: row.borrowerAddress } };
}

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findFirst: jest.fn(async ({ where }: any) => {
        const row = mockRows.find((r) => mockMatches(r, where));
        return row ? mockWithApplicant(row) : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        mockRows.filter((r) => mockMatches(r, where)).map(mockWithApplicant)
      ),
      count: jest.fn(async ({ where }: any) => mockRows.filter((r) => mockMatches(r, where)).length),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hits = mockRows.filter((r) => mockMatches(r, where));
        for (const row of hits) {
          for (const [key, value] of Object.entries(data)) {
            row[key] =
              value && typeof value === "object" && "increment" in (value as Row)
                ? row[key] + (value as Row).increment
                : value;
          }
        }
        return { count: hits.length };
      }),
    },
  },
}));
jest.mock("../services/loanHistory.js", () => ({
  diffLoanSnapshot: jest.fn(() => [{ field: "status" }]),
  recordLoanChange: jest.fn(),
  recordLoanCreation: jest.fn(),
}));
jest.mock("../services/loanReviewStages.js", () => ({
  recordStageEnter: jest.fn(),
  transitionReviewStage: jest.fn(),
}));
jest.mock("../services/assignmentQueue.js", () => ({ autoAssignApplicationReviewer: jest.fn() }));
jest.mock("../services/rateSheet.js", () => ({ priceNewOffer: jest.fn() }));

import {
  getPendingApplications,
  getReviewQueueMetrics,
  withdrawApplication,
} from "../services/loanStore.js";
import { recordLoanChange } from "../services/loanHistory.js";
import { transitionReviewStage } from "../services/loanReviewStages.js";
import { prisma } from "../services/db.js";

const OWNER = "G" + "B".repeat(55);

function seed(id: string, status: string): Row {
  const row: Row = {
    id,
    borrowerAddress: OWNER,
    applicantId: "applicant-1",
    principal: 50_000,
    status,
    version: 1,
    deletedAt: null,
    createdAt: new Date("2026-11-01T00:00:00Z"),
    withdrawnAt: null,
    withdrawalReason: null,
  };
  mockRows.push(row);
  return row;
}

beforeEach(() => {
  mockRows.length = 0;
  jest.clearAllMocks();
});

describe("withdrawApplication", () => {
  it("withdraws a Pending application, keeping the record with reason and timestamp", async () => {
    seed("loan-1", "Pending");

    const result = await withdrawApplication("loan-1", "Found a better rate");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.application).toMatchObject({
      id: "loan-1",
      status: "Withdrawn",
      withdrawalReason: "Found a better rate",
      version: 2,
    });
    expect(typeof result.application.withdrawnAt).toBe("string");
    // Record kept for history: still present, not soft-deleted.
    expect(mockRows).toHaveLength(1);
    expect(mockRows[0].deletedAt).toBeNull();
    expect(recordLoanChange).toHaveBeenCalledWith("loan-1", expect.anything());
    expect(transitionReviewStage).toHaveBeenCalledWith(undefined, "loan-1", "Withdrawn", expect.any(Date));
  });

  it("withdraws without a reason", async () => {
    seed("loan-1", "Pending");

    const result = await withdrawApplication("loan-1");

    expect(result.ok).toBe(true);
    expect(mockRows[0].withdrawalReason).toBeNull();
  });

  it("rejects a second withdrawal of the same application", async () => {
    seed("loan-1", "Pending");
    await withdrawApplication("loan-1");
    jest.clearAllMocks();

    const second = await withdrawApplication("loan-1");

    expect(second).toMatchObject({ ok: false, error: "already_withdrawn" });
    expect(prisma.loanApplication.updateMany).not.toHaveBeenCalled();
    expect(recordLoanChange).not.toHaveBeenCalled();
  });

  it.each(["Approved", "Rejected", "Disbursing", "Repaying", "Completed"])(
    "rejects withdrawing an application with a final decision (%s)",
    async (status) => {
      seed("loan-1", status);

      const result = await withdrawApplication("loan-1");

      expect(result).toMatchObject({ ok: false, error: "final_decision" });
      expect(mockRows[0].status).toBe(status);
    }
  );

  it("rejects withdrawing a Draft (drafts are discarded, not withdrawn)", async () => {
    seed("loan-1", "Draft");

    expect(await withdrawApplication("loan-1")).toMatchObject({ ok: false, error: "not_withdrawable" });
  });

  it("reports not_found for an unknown application", async () => {
    expect(await withdrawApplication("missing")).toEqual({ ok: false, error: "not_found" });
  });

  it("does not overwrite a reviewer decision that lands mid-withdrawal", async () => {
    const row = seed("loan-1", "Pending");
    const updateMany = prisma.loanApplication.updateMany as jest.Mock;
    const original = updateMany.getMockImplementation()!;
    // A reviewer approves between the read and the guarded write.
    updateMany.mockImplementationOnce(async (args: any) => {
      row.status = "Approved";
      row.version = 2;
      return original(args);
    });

    const result = await withdrawApplication("loan-1");

    expect(result).toMatchObject({ ok: false, error: "final_decision" });
    expect(row.status).toBe("Approved");
    expect(recordLoanChange).not.toHaveBeenCalled();
  });
});

describe("withdrawal and the active review queue", () => {
  it("removes the withdrawn application from the active queue and queue metrics", async () => {
    seed("loan-1", "Pending");
    seed("loan-2", "Pending");
    seed("loan-3", "Approved");

    expect(await getReviewQueueMetrics()).toEqual({ activeQueue: 2, withdrawn: 0 });

    await withdrawApplication("loan-1");

    const pending = await getPendingApplications();
    expect(pending.map((app) => app.id)).toEqual(["loan-2"]);
    expect(await getReviewQueueMetrics()).toEqual({ activeQueue: 1, withdrawn: 1 });
  });
});
