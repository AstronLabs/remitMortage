// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { runOrphanedRecordCleanupJob } from "../jobs/orphanedRecordCleanup.js";
import { prisma } from "../services/db.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    applicant: {
      findFirst: jest.fn(),
    },
    borrower: {
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    escrowDeposit: {
      deleteMany: jest.fn(),
    },
    escrowWithdrawal: {
      deleteMany: jest.fn(),
    },
    loanDisbursement: {
      deleteMany: jest.fn(),
    },
    loanRepayment: {
      deleteMany: jest.fn(),
    },
  },
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    loanRecordRetentionDays: 30,
    borrowerRecordRetentionDays: 90,
  })),
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

describe("Orphaned record cleanup job", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.loanApplication.delete as jest.Mock).mockResolvedValue({});
    (prisma.borrower.delete as jest.Mock).mockResolvedValue({});
    (prisma.escrowDeposit.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.escrowWithdrawal.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.loanDisbursement.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
    (prisma.loanRepayment.deleteMany as jest.Mock).mockResolvedValue({ count: 0 });
  });

  it("hard-deletes soft-deleted loans and borrowers past retention", async () => {
    const deletedAt = new Date("2026-01-01T00:00:00.000Z");
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      { id: "loan-purge", deletedAt, applicant: { id: "app-deleted", deletedAt } },
    ]);
    (prisma.borrower.findMany as jest.Mock).mockResolvedValue([
      { id: "borrower-purge", stellarAddress: "GPURGE" },
    ]);
    (prisma.applicant.findFirst as jest.Mock).mockResolvedValue(null);

    const summary = await runOrphanedRecordCleanupJob({
      loanRecordRetentionDays: 30,
      borrowerRecordRetentionDays: 90,
    });

    expect(prisma.loanApplication.delete).toHaveBeenCalledWith({ where: { id: "loan-purge" } });
    expect(prisma.escrowDeposit.deleteMany).toHaveBeenCalledWith({ where: { borrowerId: "borrower-purge" } });
    expect(prisma.escrowWithdrawal.deleteMany).toHaveBeenCalledWith({ where: { borrowerId: "borrower-purge" } });
    expect(prisma.loanDisbursement.deleteMany).toHaveBeenCalledWith({ where: { borrowerId: "borrower-purge" } });
    expect(prisma.loanRepayment.deleteMany).toHaveBeenCalledWith({ where: { borrowerId: "borrower-purge" } });
    expect(prisma.borrower.delete).toHaveBeenCalledWith({ where: { id: "borrower-purge" } });
    expect(summary.loanApplications.deletedCount).toBe(1);
    expect(summary.borrowers.deletedCount).toBe(1);
  });

  it("skips purge candidates still referenced by active records", async () => {
    const deletedAt = new Date("2026-01-01T00:00:00.000Z");
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      { id: "loan-active-parent", deletedAt, applicant: { id: "app-active", deletedAt: null } },
    ]);
    (prisma.borrower.findMany as jest.Mock).mockResolvedValue([
      { id: "borrower-active-ref", stellarAddress: "GACTIVE" },
    ]);
    (prisma.applicant.findFirst as jest.Mock).mockResolvedValue({ id: "app-active" });

    const summary = await runOrphanedRecordCleanupJob();

    expect(prisma.loanApplication.delete).not.toHaveBeenCalled();
    expect(prisma.borrower.delete).not.toHaveBeenCalled();
    expect(prisma.escrowDeposit.deleteMany).not.toHaveBeenCalled();
    expect(summary.loanApplications.skippedActiveReferenceCount).toBe(1);
    expect(summary.borrowers.skippedActiveReferenceCount).toBe(1);
  });
});
