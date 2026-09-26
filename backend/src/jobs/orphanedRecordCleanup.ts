// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

export interface EntityPurgeSummary {
  scannedCount: number;
  deletedCount: number;
  skippedActiveReferenceCount: number;
  retentionDays: number;
  cutoff: Date;
}

export interface OrphanedRecordCleanupSummary {
  loanApplications: EntityPurgeSummary;
  borrowers: EntityPurgeSummary;
  durationMs: number;
}

export interface OrphanedRecordCleanupRetentionOverride {
  loanRecordRetentionDays?: number;
  borrowerRecordRetentionDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolveRetentionDays(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function cutoffFor(retentionDays: number): Date {
  return new Date(Date.now() - retentionDays * MS_PER_DAY);
}

function emptyEntitySummary(retentionDays: number, cutoff: Date): EntityPurgeSummary {
  return {
    scannedCount: 0,
    deletedCount: 0,
    skippedActiveReferenceCount: 0,
    retentionDays,
    cutoff,
  };
}

async function purgeLoanApplications(cutoff: Date, retentionDays: number): Promise<EntityPurgeSummary> {
  const summary = emptyEntitySummary(retentionDays, cutoff);
  const candidates = await prisma.loanApplication.findMany({
    where: {
      deletedAt: {
        lt: cutoff,
      },
    },
    include: {
      applicant: {
        select: {
          id: true,
          deletedAt: true,
        },
      },
    },
  });

  summary.scannedCount = candidates.length;

  for (const loan of candidates) {
    if (loan.applicant && loan.applicant.deletedAt === null) {
      summary.skippedActiveReferenceCount++;
      continue;
    }

    await prisma.loanApplication.delete({ where: { id: loan.id } });
    summary.deletedCount++;
  }

  return summary;
}

async function borrowerHasActiveReference(stellarAddress: string): Promise<boolean> {
  const activeApplicant = await prisma.applicant.findFirst({
    where: {
      stellarAddress,
      OR: [
        { deletedAt: null },
        {
          loanApplications: {
            some: {
              deletedAt: null,
            },
          },
        },
      ],
    },
    select: { id: true },
  });

  return Boolean(activeApplicant);
}

async function deleteBorrowerCascade(borrowerId: string): Promise<void> {
  await prisma.escrowDeposit.deleteMany({ where: { borrowerId } });
  await prisma.escrowWithdrawal.deleteMany({ where: { borrowerId } });
  await prisma.loanDisbursement.deleteMany({ where: { borrowerId } });
  await prisma.loanRepayment.deleteMany({ where: { borrowerId } });
  await prisma.borrower.delete({ where: { id: borrowerId } });
}

async function purgeBorrowers(cutoff: Date, retentionDays: number): Promise<EntityPurgeSummary> {
  const summary = emptyEntitySummary(retentionDays, cutoff);
  const candidates = await prisma.borrower.findMany({
    where: {
      deletedAt: {
        lt: cutoff,
      },
    },
    select: {
      id: true,
      stellarAddress: true,
    },
  });

  summary.scannedCount = candidates.length;

  for (const borrower of candidates) {
    if (await borrowerHasActiveReference(borrower.stellarAddress)) {
      summary.skippedActiveReferenceCount++;
      continue;
    }

    await deleteBorrowerCascade(borrower.id);
    summary.deletedCount++;
  }

  return summary;
}

export async function runOrphanedRecordCleanupJob(
  retentionOverride: OrphanedRecordCleanupRetentionOverride = {}
): Promise<OrphanedRecordCleanupSummary> {
  const startedAt = Date.now();
  const config = loadConfig();
  const loanRetentionDays = resolveRetentionDays(
    retentionOverride.loanRecordRetentionDays ?? config.loanRecordRetentionDays
  );
  const borrowerRetentionDays = resolveRetentionDays(
    retentionOverride.borrowerRecordRetentionDays ?? config.borrowerRecordRetentionDays
  );
  const loanCutoff = cutoffFor(loanRetentionDays);
  const borrowerCutoff = cutoffFor(borrowerRetentionDays);

  logger.info("[OrphanedRecordCleanup] Starting soft-deleted record purge", {
    loanRetentionDays,
    borrowerRetentionDays,
    loanCutoff: loanCutoff.toISOString(),
    borrowerCutoff: borrowerCutoff.toISOString(),
  });

  try {
    const loanApplications = await purgeLoanApplications(loanCutoff, loanRetentionDays);
    const borrowers = await purgeBorrowers(borrowerCutoff, borrowerRetentionDays);
    const summary: OrphanedRecordCleanupSummary = {
      loanApplications,
      borrowers,
      durationMs: Date.now() - startedAt,
    };

    logger.info("[OrphanedRecordCleanup] Completed soft-deleted record purge", {
      loanApplications: {
        scannedCount: loanApplications.scannedCount,
        deletedCount: loanApplications.deletedCount,
        skippedActiveReferenceCount: loanApplications.skippedActiveReferenceCount,
        retentionDays: loanApplications.retentionDays,
        cutoff: loanApplications.cutoff.toISOString(),
      },
      borrowers: {
        scannedCount: borrowers.scannedCount,
        deletedCount: borrowers.deletedCount,
        skippedActiveReferenceCount: borrowers.skippedActiveReferenceCount,
        retentionDays: borrowers.retentionDays,
        cutoff: borrowers.cutoff.toISOString(),
      },
      durationMs: summary.durationMs,
    });

    return summary;
  } catch (error) {
    logger.error("[OrphanedRecordCleanup] Failed soft-deleted record purge", {
      error,
      loanRetentionDays,
      borrowerRetentionDays,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
