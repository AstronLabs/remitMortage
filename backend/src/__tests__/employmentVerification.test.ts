// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const upsertApplicantMock = jest.fn();
const getApplicantMock = jest.fn();
jest.mock("../services/db.js", () => ({
  upsertApplicant: (...args: unknown[]) => upsertApplicantMock(...args),
  getApplicant: (...args: unknown[]) => getApplicantMock(...args),
}));

const requestPayrollVerificationMock = jest.fn();
jest.mock("../services/payrollVerificationProvider.js", () => ({
  requestPayrollVerification: (...args: unknown[]) => requestPayrollVerificationMock(...args),
}));

const createEmploymentVerificationMock = jest.fn();
const getLatestEmploymentVerificationMock = jest.fn();
jest.mock("../services/employmentVerificationStore.js", () => ({
  createEmploymentVerification: (...args: unknown[]) => createEmploymentVerificationMock(...args),
  getLatestEmploymentVerification: (...args: unknown[]) => getLatestEmploymentVerificationMock(...args),
}));

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { verifyEmployment, getEmploymentVerificationStatus } from "../services/employmentVerification";

const ADDRESS = "GAPPLICANT1111111111111111111111111111111111111111111";
const APPLICANT = { id: "applicant-1", stellarAddress: ADDRESS };

describe("verifyEmployment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    upsertApplicantMock.mockResolvedValue(APPLICANT);
  });

  describe("successful automated verification", () => {
    it("returns VERIFIED and persists an AUTOMATED_PAYROLL record when the provider confirms income", async () => {
      requestPayrollVerificationMock.mockResolvedValue({
        covered: true,
        verified: true,
        employerName: "Acme Corp",
        verifiedMonthlyIncome: 6500,
        providerReference: "report-abc",
        providerName: "test_provider",
        error: null,
      });
      createEmploymentVerificationMock.mockResolvedValue({
        id: "ev-1",
        applicantId: "applicant-1",
        method: "AUTOMATED_PAYROLL",
        status: "VERIFIED",
        employerName: "Acme Corp",
        verifiedMonthlyIncome: 6500,
        providerReference: "report-abc",
        providerName: "test_provider",
        failureReason: null,
        verifiedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const outcome = await verifyEmployment(ADDRESS, "Acme Corp");

      expect(outcome.status).toBe("VERIFIED");
      expect(outcome.method).toBe("AUTOMATED_PAYROLL");
      expect(outcome.employerName).toBe("Acme Corp");
      expect(outcome.verifiedMonthlyIncome).toBe(6500);
      expect(outcome.verifiedAt).not.toBeNull();

      expect(createEmploymentVerificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          applicantId: "applicant-1",
          method: "AUTOMATED_PAYROLL",
          status: "VERIFIED",
          verifiedMonthlyIncome: 6500,
          providerReference: "report-abc",
        })
      );

      // Never blocked on the manual document path for a verified applicant.
      expect(getLatestEmploymentVerificationMock).not.toHaveBeenCalled();
    });
  });

  describe("employer not covered (fallback)", () => {
    it("returns NOT_COVERED and routes to manual review without blocking the applicant", async () => {
      requestPayrollVerificationMock.mockResolvedValue({
        covered: false,
        verified: false,
        employerName: null,
        verifiedMonthlyIncome: null,
        providerReference: null,
        providerName: "test_provider",
        error: null,
      });
      createEmploymentVerificationMock.mockResolvedValue({});

      const outcome = await verifyEmployment(ADDRESS, "Small Local Shop");

      expect(outcome.status).toBe("NOT_COVERED");
      expect(outcome.method).toBe("MANUAL_DOCUMENT");
      expect(outcome.verifiedMonthlyIncome).toBeNull();
      expect(outcome.message).toMatch(/pay stub/i);

      expect(createEmploymentVerificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          applicantId: "applicant-1",
          method: "MANUAL_DOCUMENT",
          status: "NOT_COVERED",
          employerName: "Small Local Shop",
        })
      );
    });

    it("also falls back to manual review when the provider is covered but can't confirm this specific applicant", async () => {
      requestPayrollVerificationMock.mockResolvedValue({
        covered: true,
        verified: false,
        employerName: null,
        verifiedMonthlyIncome: null,
        providerReference: null,
        providerName: "test_provider",
        error: null,
      });
      createEmploymentVerificationMock.mockResolvedValue({});

      const outcome = await verifyEmployment(ADDRESS, "Acme Corp");

      expect(outcome.status).toBe("NOT_COVERED");
      expect(outcome.method).toBe("MANUAL_DOCUMENT");
    });
  });

  describe("provider error handling", () => {
    it("returns FAILED and still routes to manual review — never blocks or throws to the caller", async () => {
      requestPayrollVerificationMock.mockResolvedValue({
        covered: false,
        verified: false,
        employerName: null,
        verifiedMonthlyIncome: null,
        providerReference: null,
        providerName: null,
        error: "provider timed out",
      });
      createEmploymentVerificationMock.mockResolvedValue({});

      const outcome = await verifyEmployment(ADDRESS, "Acme Corp");

      expect(outcome.status).toBe("FAILED");
      expect(outcome.method).toBe("MANUAL_DOCUMENT");
      expect(outcome.message).toMatch(/temporarily unavailable/i);

      expect(createEmploymentVerificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "FAILED",
          failureReason: "provider timed out",
        })
      );
    });
  });

  it("resolves or creates the applicant before requesting verification", async () => {
    requestPayrollVerificationMock.mockResolvedValue({
      covered: false,
      verified: false,
      employerName: null,
      verifiedMonthlyIncome: null,
      providerReference: null,
      providerName: null,
      error: null,
    });
    createEmploymentVerificationMock.mockResolvedValue({});

    await verifyEmployment(ADDRESS, "Acme Corp");

    expect(upsertApplicantMock).toHaveBeenCalledWith(ADDRESS, {});
  });
});

describe("getEmploymentVerificationStatus", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns null without touching the store when no applicant exists yet", async () => {
    getApplicantMock.mockResolvedValue(null);

    const result = await getEmploymentVerificationStatus(ADDRESS);

    expect(result).toBeNull();
    expect(getLatestEmploymentVerificationMock).not.toHaveBeenCalled();
  });

  it("returns the latest verification record for an existing applicant", async () => {
    getApplicantMock.mockResolvedValue(APPLICANT);
    getLatestEmploymentVerificationMock.mockResolvedValue({ id: "ev-1", status: "VERIFIED" });

    const result = await getEmploymentVerificationStatus(ADDRESS);

    expect(getLatestEmploymentVerificationMock).toHaveBeenCalledWith("applicant-1");
    expect(result).toEqual({ id: "ev-1", status: "VERIFIED" });
  });
});
