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

import {
  verifyEmployment,
  verifyEmploymentSources,
  getEmploymentVerificationStatus,
} from "../services/employmentVerification";

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

describe("verifyEmploymentSources (multiple income sources)", () => {
  function verifiedResult(employerName: string, verifiedMonthlyIncome: number) {
    return {
      covered: true,
      verified: true,
      employerName,
      verifiedMonthlyIncome,
      providerReference: `report-${employerName}`,
      providerName: "test_provider",
      error: null,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    upsertApplicantMock.mockResolvedValue(APPLICANT);
    createEmploymentVerificationMock.mockResolvedValue({});
  });

  it("verifies every source automatically and combines their income", async () => {
    requestPayrollVerificationMock.mockImplementation(async ({ employerName }: { employerName: string }) =>
      employerName === "Acme Corp" ? verifiedResult("Acme Corp", 3200) : verifiedResult("Night Shift Co", 1800)
    );

    const outcome = await verifyEmploymentSources(ADDRESS, ["Acme Corp", "Night Shift Co"]);

    expect(outcome.sources.map((s) => s.status)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(outcome.sources.map((s) => s.employerName)).toEqual(["Acme Corp", "Night Shift Co"]);
    expect(outcome.verifiedSourceCount).toBe(2);
    expect(outcome.manualReviewSourceCount).toBe(0);
    expect(outcome.combinedVerifiedMonthlyIncome).toBe(5000);

    // The applicant is resolved once, and each source gets its own record.
    expect(upsertApplicantMock).toHaveBeenCalledTimes(1);
    expect(requestPayrollVerificationMock).toHaveBeenCalledTimes(2);
    expect(createEmploymentVerificationMock).toHaveBeenCalledTimes(2);
  });

  it("lets automatic sources complete when another falls back to manual review", async () => {
    requestPayrollVerificationMock.mockImplementation(async ({ employerName }: { employerName: string }) => {
      if (employerName === "Acme Corp") return verifiedResult("Acme Corp", 4000);
      if (employerName === "Freelance") {
        return {
          covered: false,
          verified: false,
          employerName: null,
          verifiedMonthlyIncome: null,
          providerReference: null,
          providerName: "test_provider",
          error: null,
        };
      }
      return {
        covered: false,
        verified: false,
        employerName: null,
        verifiedMonthlyIncome: null,
        providerReference: null,
        providerName: null,
        error: "provider timed out",
      };
    });

    const outcome = await verifyEmploymentSources(ADDRESS, ["Freelance", "Acme Corp", "Flaky Employer"]);

    expect(outcome.sources.map((s) => s.status)).toEqual(["NOT_COVERED", "VERIFIED", "FAILED"]);
    expect(outcome.sources[0].method).toBe("MANUAL_DOCUMENT");
    expect(outcome.sources[2].method).toBe("MANUAL_DOCUMENT");
    expect(outcome.verifiedSourceCount).toBe(1);
    expect(outcome.manualReviewSourceCount).toBe(2);
    expect(outcome.combinedVerifiedMonthlyIncome).toBe(4000);

    expect(createEmploymentVerificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "AUTOMATED_PAYROLL", status: "VERIFIED", employerName: "Acme Corp" })
    );
    expect(createEmploymentVerificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ method: "MANUAL_DOCUMENT", status: "NOT_COVERED", employerName: "Freelance" })
    );
  });

  it("does not let an unexpected error on one source block the others", async () => {
    requestPayrollVerificationMock.mockImplementation(async ({ employerName }: { employerName: string }) => {
      if (employerName === "Broken") throw new Error("boom");
      return verifiedResult(employerName, 2500);
    });

    const outcome = await verifyEmploymentSources(ADDRESS, ["Acme Corp", "Broken", "Other Co"]);

    expect(outcome.sources.map((s) => s.status)).toEqual(["VERIFIED", "FAILED", "VERIFIED"]);
    expect(outcome.sources[1].method).toBe("MANUAL_DOCUMENT");
    expect(outcome.combinedVerifiedMonthlyIncome).toBe(5000);
  });

  it("combined income equals the sum of each verified source's amount", async () => {
    const incomes: Record<string, number> = { A: 1234.5, B: 2000, C: 765.5 };
    requestPayrollVerificationMock.mockImplementation(async ({ employerName }: { employerName: string }) =>
      verifiedResult(employerName, incomes[employerName])
    );

    const outcome = await verifyEmploymentSources(ADDRESS, ["A", "B", "C"]);

    const sumOfSources = outcome.sources.reduce((sum, s) => sum + (s.verifiedMonthlyIncome ?? 0), 0);
    expect(outcome.combinedVerifiedMonthlyIncome).toBe(sumOfSources);
    expect(outcome.combinedVerifiedMonthlyIncome).toBe(4000);
  });

  it("returns a zero combined income when every source needs manual review", async () => {
    requestPayrollVerificationMock.mockResolvedValue({
      covered: false,
      verified: false,
      employerName: null,
      verifiedMonthlyIncome: null,
      providerReference: null,
      providerName: "test_provider",
      error: null,
    });

    const outcome = await verifyEmploymentSources(ADDRESS, ["X", "Y"]);

    expect(outcome.combinedVerifiedMonthlyIncome).toBe(0);
    expect(outcome.verifiedSourceCount).toBe(0);
    expect(outcome.manualReviewSourceCount).toBe(2);
  });
});
