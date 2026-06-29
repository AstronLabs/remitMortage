import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "./db.js";

// lightweight id generator to avoid adding dependencies
function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,9)}`;
}

export type LoanStatus =
  | "Pending"
  | "Approved"
  | "Rejected"
  | "Disbursing"
  | "Repaying"
  | "Completed";

export interface LoanApplication {
  id: string;
  borrowerAddress: string;
  amount: string;
  status: LoanStatus;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

function mapLoanApplication(record: any): LoanApplication {
  return {
    id: record.id,
    borrowerAddress: record.applicant.stellarAddress,
    amount: record.principal,
    status: record.status,
    reason: record.reason ?? undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function findOrCreateApplicant(stellarAddress: string) {
  return prisma.applicant.upsert({
    where: { stellarAddress },
    update: {},
    create: { stellarAddress },
  });
}

export async function createApplication(borrowerAddress: string, amount: string) {
  StrKey.decodeEd25519PublicKey(borrowerAddress);

  const applicant = await findOrCreateApplicant(borrowerAddress);
  const id = makeId();

  const record = await prisma.loanApplication.create({
    data: {
      id,
      applicantId: applicant.id,
      principal: amount,
      status: "Pending",
    },
    include: { applicant: true },
  });

  return mapLoanApplication(record);
}

export async function getApplication(id: string) {
  const record = await prisma.loanApplication.findUnique({
    where: { id },
    include: { applicant: true },
  });

  return record ? mapLoanApplication(record) : null;
}

export async function getApplicationsByBorrower(address: string) {
  const records = await prisma.loanApplication.findMany({
    where: { applicant: { stellarAddress: address } },
    include: { applicant: true },
  });

  return records.map(mapLoanApplication);
}

export async function getPendingApplications() {
  const records = await prisma.loanApplication.findMany({
    where: { status: "Pending" },
    include: { applicant: true },
  });

  return records.map(mapLoanApplication);
}

export async function updateApplication(id: string, patch: Partial<LoanApplication>) {
  const existing = await prisma.loanApplication.findUnique({
    where: { id },
    include: { applicant: true },
  });

  if (!existing) return null;

  if (patch.borrowerAddress) {
    await prisma.applicant.update({
      where: { id: existing.applicantId },
      data: { stellarAddress: patch.borrowerAddress },
    });
  }

  const updateData: {
    principal?: string;
    status?: LoanStatus;
    reason?: string | null;
  } = {};

  if (patch.amount !== undefined) updateData.principal = patch.amount;
  if (patch.status !== undefined) updateData.status = patch.status;
  if (patch.reason !== undefined) updateData.reason = patch.reason ?? null;

  const record = Object.keys(updateData).length
    ? await prisma.loanApplication.update({
        where: { id },
        data: updateData,
        include: { applicant: true },
      })
    : await prisma.loanApplication.findUnique({
        where: { id },
        include: { applicant: true },
      });

  return record ? mapLoanApplication(record) : null;
}

// Simple escrow check: for demo purposes consider escrow "met" when requested amount is <= 5000
export function escrowTargetMetForAmount(amount: string) {
  const num = Number(amount);
  if (Number.isNaN(num) || num <= 0) return false;
  return num <= 5000;
}
