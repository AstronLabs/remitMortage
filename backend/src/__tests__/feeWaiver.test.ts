// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Late-fee hardship waiver request-to-decision flow (issue #749).
 * Covers borrower submit + track, admin approve/deny/partial, and audit
 * record completeness (amount, reason, approver). Prisma is mocked with
 * in-memory tables so the service path runs without a database.
 */

const loans: any[] = [];
const waiverRequests: any[] = [];
const auditEntries: any[] = [];

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/audit.js", () => ({
  logAudit: (entry: any) => {
    auditEntries.push(entry);
  },
}));
jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findFirst: jest.fn(async ({ where }: any) =>
        loans.find((l) => l.id === where.id) ?? null
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const loan = loans.find((l) => l.id === where.id)!;
        Object.assign(loan, data);
        return loan;
      }),
    },
    lateFeeWaiverRequest: {
      findFirst: jest.fn(async ({ where }: any) =>
        waiverRequests.find(
          (r) => r.loanApplicationId === where.loanApplicationId && r.status === where.status
        ) ?? null
      ),
      findUnique: jest.fn(async ({ where }: any) =>
        waiverRequests.find((r) => r.id === where.id) ?? null
      ),
      findMany: jest.fn(async ({ where }: any) => {
        let rows = [...waiverRequests];
        if (where?.loanApplicationId) rows = rows.filter((r) => r.loanApplicationId === where.loanApplicationId);
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        if (where?.borrowerAddress) rows = rows.filter((r) => r.borrowerAddress === where.borrowerAddress);
        return rows;
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `wr-${waiverRequests.length + 1}`, ...data, createdAt: new Date() };
        waiverRequests.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = waiverRequests.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  },
  createInAppNotification: jest.fn(),
}));

import {
  createWaiverRequest,
  decideWaiverRequest,
  listWaiverRequestsForLoan,
  listPendingWaiverQueue,
  getWaiverApprovalCriteria,
} from "../services/feeWaiver.js";

describe("hardship waiver request-to-decision flow (issue #749)", () => {
  beforeEach(() => {
    loans.length = 0;
    waiverRequests.length = 0;
    auditEntries.length = 0;
    loans.push({
      id: "loan-1",
      applicant: { stellarAddress: "GBORROWER" },
      lateFeeBalance: 150,
      deletedAt: null,
    });
  });

  it("borrower can submit a hardship waiver request and track its status", async () => {
    const created = await createWaiverRequest({
      loanId: "loan-1",
      borrowerAddress: "GBORROWER",
      hardshipReason: "JOB_LOSS",
      context: "Lost my construction job last month and cannot cover the late fee right now.",
    });
    expect(created.status).toBe("PENDING");
    expect(created.requestedAmount).toBe(150);

    const tracked = await listWaiverRequestsForLoan("loan-1");
    expect(tracked).toHaveLength(1);
    expect(tracked[0].status).toBe("PENDING");

    const queue = await listPendingWaiverQueue();
    expect(queue).toHaveLength(1);
  });

  it("admin APPROVED decision waives the full fee and records a complete audit entry", async () => {
    const created = await createWaiverRequest({
      loanId: "loan-1",
      borrowerAddress: "GBORROWER",
      hardshipReason: "MEDICAL_EMERGENCY",
      context: "Emergency surgery bills consumed all savings this month, need relief.",
    });
    const result = await decideWaiverRequest({
      requestId: created.id,
      decision: "APPROVED",
      decisionReason: "Verified hospital bills; meets criterion 1 and 2 of waiver policy.",
      decidedBy: "GADMIN",
    });
    expect(result.waivedAmount).toBe(150);
    expect(result.newLateFeeBalance).toBe(0);
    expect(loans[0].lateFeeBalance).toBe(0);

    const audit = auditEntries.find((e) => e.action === "LATE_FEE_WAIVER_DECIDED");
    expect(audit).toBeDefined();
    expect(audit.metadata.waivedAmount).toBe(150);
    expect(audit.metadata.decisionReason).toMatch(/criterion/i);
    expect(audit.actorAddress).toBe("GADMIN");
  });

  it("admin PARTIAL decision waives a strict subset and DENIED waives zero", async () => {
    const created = await createWaiverRequest({
      loanId: "loan-1",
      borrowerAddress: "GBORROWER",
      hardshipReason: "REDUCED_INCOME",
      context: "Hours were cut by half; can pay part of the fee but not all of it.",
    });
    const partial = await decideWaiverRequest({
      requestId: created.id,
      decision: "PARTIAL",
      waivedAmount: 60,
      decisionReason: "Partial hardship verified; borrower can cover remainder per criterion 4.",
      decidedBy: "GADMIN",
    });
    expect(partial.waivedAmount).toBe(60);
    expect(partial.newLateFeeBalance).toBe(90);

    loans.push({ id: "loan-2", applicant: { stellarAddress: "GB2" }, lateFeeBalance: 80, deletedAt: null });
    const created2 = await createWaiverRequest({
      loanId: "loan-2",
      borrowerAddress: "GB2",
      hardshipReason: "OTHER",
      context: "Short-term cash crunch but income intact; reviewer found no hardship proof.",
    });
    const denied = await decideWaiverRequest({
      requestId: created2.id,
      decision: "DENIED",
      decisionReason: "No supporting evidence supplied; fails criterion 1, fee stands.",
      decidedBy: "GADMIN",
    });
    expect(denied.waivedAmount).toBe(0);
    expect(denied.newLateFeeBalance).toBe(80);
  });

  it("documents approval criteria and rejects invalid input", async () => {
    expect(getWaiverApprovalCriteria().policyVersion).toBe("waiver-policy-v1");
    await expect(
      createWaiverRequest({ loanId: "loan-1", borrowerAddress: "GBORROWER", hardshipReason: "NOPE", context: "x".repeat(30) })
    ).rejects.toMatchObject({ code: "invalid_hardship_reason" });
    await expect(
      createWaiverRequest({ loanId: "loan-1", borrowerAddress: "GBORROWER", hardshipReason: "JOB_LOSS", context: "too short" })
    ).rejects.toMatchObject({ code: "invalid_context" });
  });
});
