const { PrismaClient } = require("@prisma/client") as {
  PrismaClient: new () => any;
};

export type VerificationStatus = "PENDING" | "ELIGIBLE" | "INELIGIBLE";

export const prisma = new PrismaClient();

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

// ── Applicant ─────────────────────────────────────────────────────────────

export async function upsertApplicant(
  stellarAddress: string,
  data: { verificationStatus?: VerificationStatus; creditScore?: number }
) {
  return prisma.applicant.upsert({
    where: { stellarAddress },
    update: { ...data, updatedAt: new Date() },
    create: { stellarAddress, ...data },
  });
}

export async function getApplicant(stellarAddress: string) {
  return prisma.applicant.findUnique({
    where: { stellarAddress },
    include: {
      verificationResults: { orderBy: { analyzedAt: "desc" }, take: 1 },
      loanApplications: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
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
