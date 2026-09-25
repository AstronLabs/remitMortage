// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Loan servicing transfer between originators (issue #693).
 *
 * An admin schedules a transfer with an effective date in the future. The
 * borrower and the loan's investors are notified straight away, so they hear
 * about the new servicer before it takes effect. The scheduler then applies
 * due transfers, updating the loan's servicer of record. Every transfer is
 * kept in LoanServicingTransfer, so prior servicers stay queryable.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { prisma, createInAppNotification } from "./db.js";
import { logAudit } from "./audit.js";
import logger from "../utils/logger.js";

/** Loan statuses that have servicing rights worth transferring. */
export const SERVICEABLE_STATUSES = ["Approved", "Disbursing", "Repaying"];

export class ServicingTransferError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400
  ) {
    super(message);
  }
}

export interface InitiateServicingTransferInput {
  loanId: string;
  toServicer: unknown;
  toServicerContact: unknown;
  effectiveDate: unknown;
  reason: unknown;
  investorAddresses?: unknown;
  initiatedBy: string;
  ipAddress?: string;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ServicingTransferError("missing_field", `${field} is required`);
  }
  return value.trim();
}

function parseInvestorAddresses(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ServicingTransferError("invalid_field", "investorAddresses must be an array");
  }
  for (const address of value) {
    if (typeof address !== "string" || !StrKey.isValidEd25519PublicKey(address)) {
      throw new ServicingTransferError(
        "invalid_field",
        "investorAddresses must contain Stellar G-addresses"
      );
    }
  }
  return [...new Set(value as string[])];
}

export async function initiateServicingTransfer(input: InitiateServicingTransferInput) {
  const toServicer = requireText(input.toServicer, "toServicer");
  const toServicerContact = requireText(input.toServicerContact, "toServicerContact");
  const reason = requireText(input.reason, "reason");
  const investorAddresses = parseInvestorAddresses(input.investorAddresses);

  const effectiveDate = new Date(String(input.effectiveDate ?? ""));
  if (Number.isNaN(effectiveDate.getTime())) {
    throw new ServicingTransferError("invalid_field", "effectiveDate must be a valid date");
  }
  if (effectiveDate.getTime() <= Date.now()) {
    throw new ServicingTransferError(
      "invalid_field",
      "effectiveDate must be in the future so borrower and investors are notified first"
    );
  }

  const loan = await prisma.loanApplication.findFirst({
    where: { id: input.loanId, deletedAt: null },
    include: { applicant: { select: { stellarAddress: true } } },
  });
  if (!loan) {
    throw new ServicingTransferError("not_found", "Loan application not found", 404);
  }
  if (!SERVICEABLE_STATUSES.includes(loan.status)) {
    throw new ServicingTransferError(
      "loan_not_active",
      `Servicing can only be transferred for active loans (status is ${loan.status})`,
      409
    );
  }
  if (loan.servicer === toServicer) {
    throw new ServicingTransferError("same_servicer", "Loan is already serviced by toServicer", 409);
  }

  const pending = await prisma.loanServicingTransfer.findFirst({
    where: { loanApplicationId: loan.id, status: "SCHEDULED" },
  });
  if (pending) {
    throw new ServicingTransferError(
      "transfer_already_scheduled",
      "A servicing transfer is already scheduled for this loan",
      409
    );
  }

  const transfer = await prisma.loanServicingTransfer.create({
    data: {
      loanApplicationId: loan.id,
      fromServicer: loan.servicer,
      fromServicerContact: loan.servicerContact,
      toServicer,
      toServicerContact,
      effectiveDate,
      reason,
      initiatedBy: input.initiatedBy,
    },
  });

  await notifyServicingTransfer(
    {
      loanId: loan.id,
      borrowerAddress: loan.applicant.stellarAddress,
      principal: loan.principal,
      interestRateBps: loan.interestRateBps,
      transferId: transfer.id,
      toServicer,
      toServicerContact,
      effectiveDate,
    },
    investorAddresses
  );

  const notified = await prisma.loanServicingTransfer.update({
    where: { id: transfer.id },
    data: { notifiedAt: new Date() },
  });

  logAudit({
    action: "LOAN_SERVICING_TRANSFER_SCHEDULED",
    actorAddress: input.initiatedBy,
    ipAddress: input.ipAddress,
    metadata: {
      loanId: loan.id,
      transferId: transfer.id,
      fromServicer: loan.servicer,
      toServicer,
      effectiveDate: effectiveDate.toISOString(),
      notifiedInvestors: investorAddresses.length,
    },
  });

  return notified;
}

interface TransferNotice {
  loanId: string;
  borrowerAddress: string;
  principal: number;
  interestRateBps: number;
  transferId: string;
  toServicer: string;
  toServicerContact: string;
  effectiveDate: Date;
}

async function notifyServicingTransfer(notice: TransferNotice, investorAddresses: string[]) {
  const date = notice.effectiveDate.toISOString().slice(0, 10);
  const terms = `principal ${notice.principal}, interest rate ${notice.interestRateBps / 100}%`;
  const metadata = {
    type: "LOAN_SERVICING_TRANSFER",
    loanId: notice.loanId,
    transferId: notice.transferId,
    toServicer: notice.toServicer,
    toServicerContact: notice.toServicerContact,
    effectiveDate: notice.effectiveDate.toISOString(),
  };

  await createInAppNotification({
    walletAddress: notice.borrowerAddress,
    title: "Your loan servicer is changing",
    message:
      `From ${date}, ${notice.toServicer} will service your loan ${notice.loanId}. ` +
      `Contact: ${notice.toServicerContact}. Your loan terms do not change (${terms}).`,
    variant: "info",
    metadata: { ...metadata, role: "borrower" },
  });

  for (const walletAddress of investorAddresses.filter((a) => a !== notice.borrowerAddress)) {
    await createInAppNotification({
      walletAddress,
      title: "Servicer change for a loan you fund",
      message:
        `From ${date}, ${notice.toServicer} will service loan ${notice.loanId}. ` +
        `Contact: ${notice.toServicerContact}. Loan terms do not change (${terms}).`,
      variant: "info",
      metadata: { ...metadata, role: "investor" },
    });
  }
}

/**
 * Applies every scheduled transfer whose effective date has passed: the loan's
 * servicer of record is updated and the transfer is marked completed.
 */
export async function applyDueServicingTransfers(now: Date = new Date()): Promise<number> {
  const due = await prisma.loanServicingTransfer.findMany({
    where: { status: "SCHEDULED", effectiveDate: { lte: now } },
    orderBy: { effectiveDate: "asc" },
  });

  for (const transfer of due) {
    await prisma.$transaction([
      prisma.loanApplication.update({
        where: { id: transfer.loanApplicationId },
        data: { servicer: transfer.toServicer, servicerContact: transfer.toServicerContact },
      }),
      prisma.loanServicingTransfer.update({
        where: { id: transfer.id },
        data: { status: "COMPLETED", completedAt: now },
      }),
    ]);

    logAudit({
      action: "LOAN_SERVICING_TRANSFER_COMPLETED",
      actorAddress: transfer.initiatedBy,
      metadata: {
        loanId: transfer.loanApplicationId,
        transferId: transfer.id,
        fromServicer: transfer.fromServicer,
        toServicer: transfer.toServicer,
      },
    });
  }

  if (due.length > 0) {
    logger.info(`[loan-servicing] applied ${due.length} servicing transfer(s)`);
  }
  return due.length;
}

/** Current servicer plus the full transfer history, oldest first. */
export async function getServicingHistory(loanId: string) {
  const loan = await prisma.loanApplication.findFirst({
    where: { id: loanId, deletedAt: null },
    select: {
      id: true,
      servicer: true,
      servicerContact: true,
      servicingTransfers: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!loan) return null;

  return {
    loanId: loan.id,
    servicer: loan.servicer,
    servicerContact: loan.servicerContact,
    transfers: loan.servicingTransfers,
  };
}
