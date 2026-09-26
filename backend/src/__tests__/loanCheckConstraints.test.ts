// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Prisma } from "@prisma/client";
import * as fs from "fs";

// Pure validation mirrors backend/src/services/db.ts
// (avoids importing db.js at top-level which would instantiate PrismaClient without DATABASE_URL)
const LOAN_PRINCIPAL_MIN = 0;
const LOAN_INTEREST_RATE_MIN_BPS = 200;
const LOAN_INTEREST_RATE_MAX_BPS = 1800;

function validateLoanInput(data: { principal: number; interestRateBps?: number }) {
  if (data.principal <= LOAN_PRINCIPAL_MIN) {
    throw new Error(`principal must be > ${LOAN_PRINCIPAL_MIN}`);
  }
  if (data.interestRateBps !== undefined) {
    if (
      data.interestRateBps < LOAN_INTEREST_RATE_MIN_BPS ||
      data.interestRateBps > LOAN_INTEREST_RATE_MAX_BPS
    ) {
      throw new Error(
        `interestRateBps must be between ${LOAN_INTEREST_RATE_MIN_BPS} and ${LOAN_INTEREST_RATE_MAX_BPS} (got ${data.interestRateBps})`
      );
    }
  }
}

function isCheckConstraintError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2004";
  }
  const msg = (error as Error)?.message ?? "";
  return /check constraint|LoanApplication_principal_check|LoanApplication_interestRateBps_check|23514|violates check/i.test(msg);
}

const hasDatabase = !!process.env.DATABASE_URL;

describe("LoanApplication DB CHECK constraints - app layer (no DB required)", () => {
  it("exposes correct protocol bounds as constants", () => {
    expect(LOAN_PRINCIPAL_MIN).toBe(0);
    expect(LOAN_INTEREST_RATE_MIN_BPS).toBe(200);
    expect(LOAN_INTEREST_RATE_MAX_BPS).toBe(1800);
  });

  it("validation rejects principal <= 0 at app layer", () => {
    expect(() => validateLoanInput({ principal: 0 })).toThrow(/principal must be > 0/i);
    expect(() => validateLoanInput({ principal: -100 })).toThrow(/principal must be > 0/i);
    expect(() => validateLoanInput({ principal: -0.01 })).toThrow(/principal must be > 0/i);
  });

  it("validation rejects interestRateBps out of 200..1800", () => {
    expect(() => validateLoanInput({ principal: 10000, interestRateBps: 199 })).toThrow(
      /interestRateBps must be between 200 and 1800/i
    );
    expect(() => validateLoanInput({ principal: 10000, interestRateBps: 1801 })).toThrow(
      /interestRateBps must be between 200 and 1800/i
    );
    expect(() => validateLoanInput({ principal: 10000, interestRateBps: 0 })).toThrow(
      /interestRateBps must be between 200 and 1800/i
    );
    expect(() => validateLoanInput({ principal: 10000, interestRateBps: 10000 })).toThrow(
      /interestRateBps must be between 200 and 1800/i
    );
  });

  it("validation accepts valid bounds inclusively", () => {
    expect(() => validateLoanInput({ principal: 0.01, interestRateBps: 200 })).not.toThrow();
    expect(() => validateLoanInput({ principal: 70000, interestRateBps: 800 })).not.toThrow();
    expect(() => validateLoanInput({ principal: 1000000, interestRateBps: 1800 })).not.toThrow();
    expect(() => validateLoanInput({ principal: 50000 })).not.toThrow();
  });

  it("real db.ts constants match pure validation (via fs read, no DB import)", () => {
    const content = fs.readFileSync("src/services/db.ts", "utf-8");
    expect(content).toContain("LOAN_PRINCIPAL_MIN");
    expect(content).toContain("LOAN_INTEREST_RATE_MIN_BPS = 200");
    expect(content).toContain("LOAN_INTEREST_RATE_MAX_BPS = 1800");
  });
});

// DB-layer tests - require real Postgres
const describeDB = hasDatabase ? describe : describe.skip;

describeDB("LoanApplication DB CHECK constraints - database layer (bypassing app validation)", () => {
  let prisma: any;
  let applicantId: string;

  beforeAll(async () => {
    const db = await import("../services/db.js");
    prisma = db.prisma;
    await prisma.$connect();
    const applicant = await prisma.applicant.create({
      data: {
        stellarAddress: `GTEST${Date.now().toString().padStart(48, "0")}CHECKS`,
        verificationStatus: "PENDING",
      },
    });
    applicantId = applicant.id;
  });

  afterAll(async () => {
    if (prisma) {
      try {
        await prisma.loanApplication.deleteMany({ where: { applicantId } });
        await prisma.applicant.delete({ where: { id: applicantId } });
      } catch {}
      await prisma.$disconnect();
    }
  });

  afterEach(async () => {
    if (prisma) {
      await prisma.loanApplication.deleteMany({ where: { applicantId } });
    }
  });

  it("rejects principal <= 0 even when bypassing app validation via raw prisma", async () => {
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 0, interestRateBps: 800 } })
    ).rejects.toSatisfy(isCheckConstraintError);
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: -1, interestRateBps: 800 } })
    ).rejects.toSatisfy(isCheckConstraintError);
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: -99999, interestRateBps: 800 } })
    ).rejects.toSatisfy(isCheckConstraintError);
  });

  it("rejects principal = 0 via raw SQL even bypassing Prisma", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "LoanApplication" ("id", "applicantId", "principal", "interestRateBps", "status", "createdAt", "statusUpdatedAt") VALUES (gen_random_uuid(), ${applicantId}, 0, 800, 'Pending', NOW(), NOW())`
    ).rejects.toSatisfy(isCheckConstraintError);
  });

  it("rejects interestRateBps < 200 even bypassing app validation", async () => {
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 10000, interestRateBps: 199 } })
    ).rejects.toSatisfy(isCheckConstraintError);
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 10000, interestRateBps: 0 } })
    ).rejects.toSatisfy(isCheckConstraintError);
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 10000, interestRateBps: 1 } })
    ).rejects.toSatisfy(isCheckConstraintError);
  });

  it("rejects interestRateBps > 1800 even bypassing app validation", async () => {
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 10000, interestRateBps: 1801 } })
    ).rejects.toSatisfy(isCheckConstraintError);
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 10000, interestRateBps: 10000 } })
    ).rejects.toSatisfy(isCheckConstraintError);
  });

  it("rejects interestRateBps via raw SQL", async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "LoanApplication" ("id", "applicantId", "principal", "interestRateBps", "status", "createdAt", "statusUpdatedAt") VALUES (gen_random_uuid(), ${applicantId}, 10000, 199, 'Pending', NOW(), NOW())`
    ).rejects.toSatisfy(isCheckConstraintError);
    await expect(
      prisma.$executeRaw`INSERT INTO "LoanApplication" ("id", "applicantId", "principal", "interestRateBps", "status", "createdAt", "statusUpdatedAt") VALUES (gen_random_uuid(), ${applicantId}, 10000, 1801, 'Pending', NOW(), NOW())`
    ).rejects.toSatisfy(isCheckConstraintError);
  });

  it("accepts valid production-shaped data (principal 70000, rate 800) and edge bounds", async () => {
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 70000, interestRateBps: 800 } })
    ).resolves.toBeDefined();
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 0.01, interestRateBps: 200 } })
    ).resolves.toBeDefined();
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 1000000, interestRateBps: 1800 } })
    ).resolves.toBeDefined();
    const loan = await prisma.loanApplication.create({ data: { applicantId, principal: 50000 } });
    expect(loan.interestRateBps).toBe(800);
  });

  it("existing valid data passes migration - no rows violate new checks", async () => {
    const violatingPrincipal = await prisma.$queryRaw`SELECT count(*) as count FROM "LoanApplication" WHERE "principal" <= 0`;
    const countPrincipal = Number((violatingPrincipal as any)[0]?.count ?? 0);
    expect(countPrincipal).toBe(0);
    const violatingRate = await prisma.$queryRaw`SELECT count(*) as count FROM "LoanApplication" WHERE "interestRateBps" < 200 OR "interestRateBps" > 1800`;
    const countRate = Number((violatingRate as any)[0]?.count ?? 0);
    expect(countRate).toBe(0);
  });

  it("returns clear constraint error message containing check name", async () => {
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: -5, interestRateBps: 800 } })
    ).rejects.toThrow(/LoanApplication_principal_check|check constraint|principal/i);
    await expect(
      prisma.loanApplication.create({ data: { applicantId, principal: 10000, interestRateBps: 5000 } })
    ).rejects.toThrow(/LoanApplication_interestRateBps_check|check constraint|interestRateBps/i);
  });
});

declare global {
  namespace jest {
    interface Matchers<R> {
      toSatisfy(predicate: (value: any) => boolean): R;
    }
  }
}

expect.extend({
  toSatisfy(received: unknown, predicate: (value: unknown) => boolean) {
    const pass = predicate(received);
    if (pass) {
      return { message: () => `expected value not to satisfy predicate`, pass: true };
    }
    return {
      message: () =>
        `expected value to satisfy predicate, received: ${JSON.stringify(
          received instanceof Error ? received.message : received
        )}`,
      pass: false,
    };
  },
});
