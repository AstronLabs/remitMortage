// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Route-level tests for POST/GET /api/kyc/:address/employment-verification.
 *
 * The employmentVerification service is mocked at the module level — these
 * tests only exercise routing/auth/validation, not the underlying provider
 * logic (covered separately in employmentVerification.test.ts and
 * payrollVerificationProvider.test.ts).
 */

import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

jest.mock("../config.js", () => ({
  loadConfig: () => ({
    adminApiKey: "test-admin-key",
    kmsKeyVersions: { v1: "1".repeat(64) },
    kmsActiveKeyVersion: "v1",
    kycOperatorSecret: "test-operator-secret",
    kycAccessTokenTtlSeconds: 300,
  }),
}));

const verifyEmploymentMock = jest.fn();
const getEmploymentVerificationStatusMock = jest.fn();
jest.mock("../services/employmentVerification.js", () => ({
  verifyEmployment: (...args: unknown[]) => verifyEmploymentMock(...args),
  getEmploymentVerificationStatus: (...args: unknown[]) => getEmploymentVerificationStatusMock(...args),
}));

// kyc.ts imports these regardless of which route is under test — stub them
// out so the module loads without needing a real Prisma client, storage, or
// OCR provider.
jest.mock("../services/db.js", () => ({ prisma: {} }));
jest.mock("../services/kycOcrStore.js", () => ({
  createOcrResult: jest.fn(),
  getOcrResult: jest.fn(),
  confirmOcrFields: jest.fn(),
  getUnconfirmedFields: jest.fn(),
}));
jest.mock("../services/kycStorage.js", () => ({
  storeEncryptedDocument: jest.fn(),
  getEncryptedDocument: jest.fn(),
}));

import { kycRouter } from "../routes/kyc.js";

const BORROWER_ADDRESS = "GBORROWERADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const OTHER_ADDRESS = "GOTHERWALLETADDRESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function borrowerToken(address = BORROWER_ADDRESS): string {
  return jwt.sign(
    { walletAddress: address, network: "stellar" },
    process.env.JWT_SECRET || "default_jwt_secret"
  );
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/kyc", kycRouter);
  return app;
}

let app: express.Express;

beforeEach(() => {
  jest.clearAllMocks();
  app = buildApp();
});

describe("POST /api/kyc/:address/employment-verification", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .send({ employerName: "Acme Corp" });

    expect(res.status).toBe(401);
    expect(verifyEmploymentMock).not.toHaveBeenCalled();
  });

  it("rejects a caller verifying employment for someone else's address", async () => {
    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken(OTHER_ADDRESS)}`)
      .send({ employerName: "Acme Corp" });

    expect(res.status).toBe(403);
    expect(verifyEmploymentMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no employerName", async () => {
    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_field");
    expect(verifyEmploymentMock).not.toHaveBeenCalled();
  });

  it("returns a VERIFIED outcome for a covered, confirmed employer", async () => {
    verifyEmploymentMock.mockResolvedValue({
      status: "VERIFIED",
      method: "AUTOMATED_PAYROLL",
      employerName: "Acme Corp",
      verifiedMonthlyIncome: 6500,
      verifiedAt: "2026-09-28T00:00:00.000Z",
      message: "Employment and income verified automatically.",
    });

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ employerName: "Acme Corp" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("VERIFIED");
    expect(res.body.verifiedMonthlyIncome).toBe(6500);
    expect(verifyEmploymentMock).toHaveBeenCalledWith(BORROWER_ADDRESS, "Acme Corp");
  });

  it("returns 200 with NOT_COVERED (not an error status) when the employer isn't supported", async () => {
    verifyEmploymentMock.mockResolvedValue({
      status: "NOT_COVERED",
      method: "MANUAL_DOCUMENT",
      employerName: null,
      verifiedMonthlyIncome: null,
      verifiedAt: null,
      message: "Your employer isn't yet supported for automatic verification. Please upload a pay stub for manual review.",
    });

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ employerName: "Small Local Shop" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("NOT_COVERED");
    expect(res.body.method).toBe("MANUAL_DOCUMENT");
  });

  it("returns 200 with FAILED (still not a 5xx) when the provider errors", async () => {
    verifyEmploymentMock.mockResolvedValue({
      status: "FAILED",
      method: "MANUAL_DOCUMENT",
      employerName: null,
      verifiedMonthlyIncome: null,
      verifiedAt: null,
      message: "Automated employment verification is temporarily unavailable. Please upload a pay stub for manual review.",
    });

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ employerName: "Acme Corp" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FAILED");
  });

  it("returns 500 only for a genuinely unexpected error, not a provider decline", async () => {
    verifyEmploymentMock.mockRejectedValue(new Error("database unreachable"));

    const res = await request(app)
      .post(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`)
      .send({ employerName: "Acme Corp" });

    expect(res.status).toBe(500);
  });
});

describe("GET /api/kyc/:address/employment-verification", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`);
    expect(res.status).toBe(401);
  });

  it("rejects a caller viewing someone else's verification status", async () => {
    const res = await request(app)
      .get(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken(OTHER_ADDRESS)}`);

    expect(res.status).toBe(403);
    expect(getEmploymentVerificationStatusMock).not.toHaveBeenCalled();
  });

  it("returns null when no verification attempt has been made yet", async () => {
    getEmploymentVerificationStatusMock.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verification: null });
  });

  it("returns the latest verification record", async () => {
    getEmploymentVerificationStatusMock.mockResolvedValue({
      id: "ev-1",
      status: "VERIFIED",
      method: "AUTOMATED_PAYROLL",
    });

    const res = await request(app)
      .get(`/api/kyc/${BORROWER_ADDRESS}/employment-verification`)
      .set("Authorization", `Bearer ${borrowerToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.verification).toEqual({ id: "ev-1", status: "VERIFIED", method: "AUTOMATED_PAYROLL" });
    expect(getEmploymentVerificationStatusMock).toHaveBeenCalledWith(BORROWER_ADDRESS);
  });
});
