import { PrismaClient, VerificationStatus, LoanStatus } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const applicant = await prisma.applicant.upsert({
    where: { stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF" },
    update: {},
    create: {
      stellarAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      verificationStatus: VerificationStatus.ELIGIBLE,
      creditScore: 72,
    },
  });

  await prisma.verificationResult.create({
    data: {
      applicantId: applicant.id,
      reportHash: "sha256-seed-placeholder-hash",
      totalPayments: 24,
      totalVolume: 12000,
      spanMonths: 12,
      eligible: true,
    },
  });

  await prisma.loanApplication.create({
    data: {
      applicantId: applicant.id,
      principal: 70000,
      status: LoanStatus.PENDING,
    },
  });

  console.log("Seed complete.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
