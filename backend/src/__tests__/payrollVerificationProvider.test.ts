// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import axios from "axios";
import {
  HttpPayrollVerificationProvider,
  NullPayrollVerificationProvider,
  requestPayrollVerification,
  setPayrollVerificationProvider,
  type PayrollVerificationProvider,
} from "../services/payrollVerificationProvider.js";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const REQUEST = { applicantAddress: "GAPPLICANT1111111111111111111111111111111111111111111", employerName: "Acme Corp" };

describe("NullPayrollVerificationProvider", () => {
  it("always reports the employer as not covered", async () => {
    const provider = new NullPayrollVerificationProvider();
    const result = await provider.verify(REQUEST);
    expect(result).toEqual({
      covered: false,
      verified: false,
      employerName: null,
      verifiedMonthlyIncome: null,
      providerReference: null,
      providerName: null,
      error: null,
    });
  });
});

describe("HttpPayrollVerificationProvider", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns a verified result when the provider confirms employment and income", async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        covered: true,
        verified: true,
        employerName: "Acme Corp",
        monthlyIncome: 6500,
        referenceId: "report-abc-123",
      },
    });

    const provider = new HttpPayrollVerificationProvider({
      url: "https://payroll.example.com/verify",
      apiKey: "test-key",
      providerName: "test_provider",
    });
    const result = await provider.verify(REQUEST);

    expect(result).toEqual({
      covered: true,
      verified: true,
      employerName: "Acme Corp",
      verifiedMonthlyIncome: 6500,
      providerReference: "report-abc-123",
      providerName: "test_provider",
      error: null,
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://payroll.example.com/verify",
      { employerName: "Acme Corp", applicantReference: REQUEST.applicantAddress },
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } })
    );
  });

  it("reports not covered when the provider says the employer isn't in its network", async () => {
    mockedAxios.post.mockResolvedValue({ data: { covered: false } });

    const provider = new HttpPayrollVerificationProvider({ url: "https://payroll.example.com/verify" });
    const result = await provider.verify(REQUEST);

    expect(result.covered).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toBeNull();
  });

  it("does not report verified when covered but the provider has no income figure", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { covered: true, verified: true, employerName: "Acme Corp" }, // no monthlyIncome
    });

    const provider = new HttpPayrollVerificationProvider({ url: "https://payroll.example.com/verify" });
    const result = await provider.verify(REQUEST);

    expect(result.covered).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.verifiedMonthlyIncome).toBeNull();
    expect(result.employerName).toBeNull();
  });

  it("does not report verified when covered and income is present but the provider says verified: false", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { covered: true, verified: false, employerName: "Acme Corp", monthlyIncome: 6500 },
    });

    const provider = new HttpPayrollVerificationProvider({ url: "https://payroll.example.com/verify" });
    const result = await provider.verify(REQUEST);

    expect(result.covered).toBe(true);
    expect(result.verified).toBe(false);
  });

  it("propagates a transport error to the caller", async () => {
    mockedAxios.post.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const provider = new HttpPayrollVerificationProvider({ url: "https://payroll.example.com/verify" });
    await expect(provider.verify(REQUEST)).rejects.toThrow("connect ECONNREFUSED");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    mockedAxios.post.mockResolvedValue({ data: { covered: false } });
    const provider = new HttpPayrollVerificationProvider({ url: "https://payroll.example.com/verify" });
    await provider.verify(REQUEST);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ headers: {} })
    );
  });
});

describe("requestPayrollVerification (never throws)", () => {
  afterEach(() => {
    setPayrollVerificationProvider(new NullPayrollVerificationProvider());
  });

  it("delegates to the active provider on success", async () => {
    const provider: PayrollVerificationProvider = {
      verify: jest.fn().mockResolvedValue({
        covered: true,
        verified: true,
        employerName: "Acme Corp",
        verifiedMonthlyIncome: 5000,
        providerReference: "ref-1",
        providerName: "test_provider",
        error: null,
      }),
    };
    setPayrollVerificationProvider(provider);

    const result = await requestPayrollVerification(REQUEST);
    expect(result.verified).toBe(true);
    expect(provider.verify).toHaveBeenCalledWith(REQUEST);
  });

  it("normalizes a thrown provider error into a non-covered result with `error` set", async () => {
    const provider: PayrollVerificationProvider = {
      verify: jest.fn().mockRejectedValue(new Error("provider timed out")),
    };
    setPayrollVerificationProvider(provider);

    const result = await requestPayrollVerification(REQUEST);

    expect(result.covered).toBe(false);
    expect(result.verified).toBe(false);
    expect(result.error).toBe("provider timed out");
  });
});
