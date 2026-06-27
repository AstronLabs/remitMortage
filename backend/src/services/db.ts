const { PrismaClient } = require("@prisma/client") as {
  PrismaClient: new () => any;
};

import { encrypt, decrypt } from "../utils/crypto.js";

export type VerificationStatus = "PENDING" | "ELIGIBLE" | "INELIGIBLE";

export const prisma = new PrismaClient();

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

// ── Applicant ─────────────────────────────────────────────────────────────

const ENCRYPTED_FIELDS = ["taxId", "monthlyIncome"] as const;

function encryptFields<T extends Record<string, any>>(data: T): T {
  const result = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = encrypt(String(result[field]));
    }
  }
  return result;
}

function decryptApplicant(applicant: any): any {
  if (!applicant) return applicant;
  const result = { ...applicant };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = decrypt(result[field]);
    }
  }
  return result;
}

export async function upsertApplicant(
  stellarAddress: string,
  data: {
    verificationStatus?: VerificationStatus;
    creditScore?: number;
    taxId?: string;
    monthlyIncome?: string;
  }
) {
  const encrypted = encryptFields(data);
  return prisma.applicant.upsert({
    where: { stellarAddress },
    update: { ...encrypted, updatedAt: new Date() },
    create: { stellarAddress, ...encrypted },
  });
}

export async function getApplicant(stellarAddress: string) {
  const applicant = await prisma.applicant.findUnique({
    where: { stellarAddress },
    include: {
      verificationResults: { orderBy: { analyzedAt: "desc" }, take: 1 },
      loanApplications: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  return decryptApplicant(applicant);
}

// ── VerificationResult ────────────────────────────────────────────────────

export async function createVerificationResult(data: {
  applicantId: string;
  reportHash: string;
  totalPayments: number;
  totalVolume: number;
  spanMonths: number;
  eligible: boolean;
}) {
  return prisma.verificationResult.create({ data });
}

// ── LoanApplication ────────────────────────────────────────────────────────

export async function createLoanApplication(data: {
  applicantId: string;
  escrowContractId?: string;
  loanId?: string;
  principal: number;
}) {
  return prisma.loanApplication.create({ data });
}
