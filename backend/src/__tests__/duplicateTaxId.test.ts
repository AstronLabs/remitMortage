// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Duplicate applicant SSN/tax ID detection (issue #692).
 *
 * Prisma is mocked with a tiny in-memory applicant table so the tests can
 * assert both the match behaviour and that the raw tax ID never reaches
 * storage, logs or responses.
 */

import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";
import { normalizeTaxId, hashTaxId } from "../utils/taxIdHash.js";
import { maskSensitiveData } from "../middleware/logMasker.js";

jest.mock("../config.js", () => ({
  loadConfig: () => ({ taxIdHashSecret: "test-tax-id-secret" }),
}));

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("../utils/logger.js", () => ({ __esModule: true, default: mockLogger }));

type Row = { id: string; stellarAddress: string; taxIdHash: string | null; deletedAt: null; createdAt: Date };
const applicants: Row[] = [];
const applicationUpdates: any[] = [];

jest.mock("../services/db.js", () => ({
  prisma: {
    applicant: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async ({ where }: any) =>
        applicants
          .filter((a) => {
            if (where.taxIdHash !== undefined && a.taxIdHash !== where.taxIdHash) return false;
            if (where.stellarAddress?.not && a.stellarAddress === where.stellarAddress.not) return false;
            return true;
          })
          .map((a) => ({ ...a, loanApplications: [] }))
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const row = applicants.find((a) => a.stellarAddress === where.stellarAddress);
        if (row) Object.assign(row, data);
        return row;
      }),
    },
    loanApplication: {
      update: jest.fn(async (args: any) => {
        applicationUpdates.push(args);
        return args;
      }),
    },
  },
}));

jest.mock("../services/loanStore.js", () => ({
  createApplication: jest.fn(async (borrowerAddress: string, amount: string) => {
    if (!applicants.some((a) => a.stellarAddress === borrowerAddress)) {
      applicants.push({
        id: `app-${applicants.length + 1}`,
        stellarAddress: borrowerAddress,
        taxIdHash: null,
        deletedAt: null,
        createdAt: new Date(),
      });
    }
    return {
      id: `loan-${applicationUpdates.length + 1}-${borrowerAddress.slice(0, 4)}`,
      borrowerAddress,
      amount,
      status: "Pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }),
  escrowTargetMetForAmount: jest.fn(() => true),
  getApplication: jest.fn(),
  getApplicationsByBorrower: jest.fn(),
  getPendingApplications: jest.fn(),
  updateApplication: jest.fn(),
  resumeDraftApplication: jest.fn(),
  discardDraftApplication: jest.fn(),
}));

jest.mock("../jobs/kycExpiryReminder.js", () => ({ hasExpiredKycDocuments: jest.fn(async () => false) }));
jest.mock("../services/notification.js", () => ({ queueNotification: jest.fn() }));
jest.mock("../services/redis.js", () => ({ getRedisClient: () => null }));

// Imported after the mocks so the router picks them up.
import { loanRouter } from "../routes/loan.js";
import { findTaxIdMatches, recordApplicantTaxIdHash } from "../services/taxIdDedup.js";

const app = express();
app.use(express.json());
app.use("/api/loan", loanRouter);

function apply(borrowerAddress: string, taxId?: string) {
  return request(app)
    .post("/api/loan/apply")
    .send({ borrowerAddress, amount: 1000, ...(taxId ? { taxId } : {}) });
}

beforeEach(() => {
  applicants.length = 0;
  applicationUpdates.length = 0;
  jest.clearAllMocks();
});

describe("normalizeTaxId / hashTaxId", () => {
  it("normalizes dashes, spaces and case", () => {
    expect(normalizeTaxId("123-45-6789")).toBe("123456789");
    expect(normalizeTaxId(" 123 45 6789 ")).toBe("123456789");
    expect(normalizeTaxId("12-3456789")).toBe("123456789");
    expect(normalizeTaxId("ab.12/34")).toBe("AB1234");
    expect(normalizeTaxId(" - ")).toBeNull();
  });

  it("hashes formatting variants to the same value and never contains the raw ID", () => {
    const hash = hashTaxId("123-45-6789");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashTaxId("123 45 6789")).toBe(hash);
    expect(hashTaxId("123456789")).toBe(hash);
    expect(hash).not.toContain("123456789");
    expect(hashTaxId("987-65-4321")).not.toBe(hash);
    expect(hashTaxId("")).toBeNull();
  });
});

describe("taxIdDedup service", () => {
  it("stores only the hash", async () => {
    applicants.push({ id: "a1", stellarAddress: "GA", taxIdHash: null, deletedAt: null, createdAt: new Date() });

    await recordApplicantTaxIdHash("GA", "123-45-6789");

    expect(applicants[0].taxIdHash).toBe(hashTaxId("123456789"));
    expect(JSON.stringify(applicants)).not.toContain("6789");
  });

  it("finds no match, an exact match, and a match despite different formatting", async () => {
    applicants.push({
      id: "a1",
      stellarAddress: "GA",
      taxIdHash: hashTaxId("123456789"),
      deletedAt: null,
      createdAt: new Date(),
    });

    expect(await findTaxIdMatches("987-65-4321", "GB")).toHaveLength(0);
    expect(await findTaxIdMatches("123456789", "GB")).toHaveLength(1);
    expect(await findTaxIdMatches("123 - 45 - 6789", "GB")).toHaveLength(1);
  });

  it("does not match an applicant against their own record", async () => {
    applicants.push({
      id: "a1",
      stellarAddress: "GA",
      taxIdHash: hashTaxId("123456789"),
      deletedAt: null,
      createdAt: new Date(),
    });

    expect(await findTaxIdMatches("123-45-6789", "GA")).toHaveLength(0);
  });
});

describe("POST /api/loan/apply duplicate tax ID detection", () => {
  const first = Keypair.random().publicKey();
  const second = Keypair.random().publicKey();

  it("processes an application normally when no other applicant has the tax ID", async () => {
    const res = await apply(first, "123-45-6789");

    expect(res.status).toBe(201);
    expect(res.body.manualReviewReason).toBeUndefined();
    expect(applicationUpdates).toHaveLength(0);
  });

  it("holds an application for manual review when the tax ID matches another applicant", async () => {
    await apply(first, "123-45-6789");
    const res = await apply(second, "123 45 6789");

    expect(res.status).toBe(201);
    expect(res.body.manualReviewReason).toBe("DUPLICATE_TAX_ID");
    expect(applicationUpdates).toEqual([
      { where: { id: res.body.id }, data: { manualReviewReason: "DUPLICATE_TAX_ID" } },
    ]);
  });

  it("does not flag the same applicant re-applying with their own tax ID", async () => {
    await apply(first, "123-45-6789");
    const res = await apply(first, "123456789");

    expect(res.body.manualReviewReason).toBeUndefined();
    expect(applicationUpdates).toHaveLength(0);
  });

  it("never returns, stores or logs the raw tax ID", async () => {
    await apply(first, "123-45-6789");
    const res = await apply(second, "123-45-6789");

    const everything = JSON.stringify({
      body: res.body,
      applicants,
      applicationUpdates,
      logs: [mockLogger.info, mockLogger.warn, mockLogger.error].map((fn) => fn.mock.calls),
    });
    expect(everything).not.toContain("123-45-6789");
    expect(everything).not.toContain("123456789");
  });
});

describe("request log masking", () => {
  it("masks taxId in logged request bodies", () => {
    expect(maskSensitiveData({ taxId: "123-45-6789", tax_id: "1", amount: 5 })).toEqual({
      taxId: "***",
      tax_id: "***",
      amount: 5,
    });
  });
});
