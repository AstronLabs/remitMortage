// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import axios from "axios";
import {
  HttpAddressVerificationProvider,
  NullAddressVerificationProvider,
  requestAddressVerification,
  setAddressVerificationProvider,
  type AddressVerificationProvider,
} from "../services/addressVerificationProvider.js";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/apiScopeUsageTracker.js", () => ({
  recordApiCapabilityUsage: jest.fn().mockResolvedValue(undefined),
}));

const INPUT = {
  line1: "123 Main St",
  city: "Springfield",
  state: "IL",
  postalCode: "62704",
  country: "US",
};

describe("NullAddressVerificationProvider", () => {
  it("never claims to have verified anything", async () => {
    const provider = new NullAddressVerificationProvider();
    const result = await provider.verify(INPUT);
    expect(result).toEqual({
      available: false,
      valid: false,
      standardized: null,
      providerReference: null,
      providerName: null,
      error: null,
    });
  });
});

describe("HttpAddressVerificationProvider", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns a standardized address when the provider confirms deliverability", async () => {
    mockedAxios.post.mockResolvedValue({
      data: {
        deliverable: true,
        referenceId: "usps-ref-1",
        standardizedAddress: {
          line1: "123 MAIN ST",
          city: "SPRINGFIELD",
          state: "IL",
          postalCode: "62704-1234",
          country: "US",
        },
      },
    });

    const provider = new HttpAddressVerificationProvider({
      url: "https://postal.example.com/verify",
      apiKey: "test-key",
      providerName: "usps",
    });
    const result = await provider.verify(INPUT);

    expect(result).toEqual({
      available: true,
      valid: true,
      standardized: {
        line1: "123 MAIN ST",
        line2: null,
        city: "SPRINGFIELD",
        state: "IL",
        postalCode: "62704-1234",
        country: "US",
      },
      providerReference: "usps-ref-1",
      providerName: "usps",
      error: null,
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://postal.example.com/verify",
      { address: INPUT },
      expect.objectContaining({ headers: { Authorization: "Bearer test-key" } })
    );
  });

  it("reports not valid when the provider says the address isn't deliverable", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { deliverable: false, referenceId: "usps-ref-2" },
    });

    const provider = new HttpAddressVerificationProvider({ url: "https://postal.example.com/verify" });
    const result = await provider.verify(INPUT);

    expect(result.available).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.standardized).toBeNull();
    expect(result.error).toBeNull();
  });

  it("treats a 'deliverable' response with no usable standardized address as not valid", async () => {
    mockedAxios.post.mockResolvedValue({
      data: { deliverable: true, standardizedAddress: { city: "Springfield" } }, // missing line1/state/postalCode/country
    });

    const provider = new HttpAddressVerificationProvider({ url: "https://postal.example.com/verify" });
    const result = await provider.verify(INPUT);

    expect(result.available).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.standardized).toBeNull();
    expect(result.error).toMatch(/no usable standardized address/i);
  });

  it("propagates a transport error to the caller", async () => {
    mockedAxios.post.mockRejectedValue(new Error("connect ECONNREFUSED"));

    const provider = new HttpAddressVerificationProvider({ url: "https://postal.example.com/verify" });
    await expect(provider.verify(INPUT)).rejects.toThrow("connect ECONNREFUSED");
  });

  it("omits the Authorization header when no API key is configured", async () => {
    mockedAxios.post.mockResolvedValue({ data: { deliverable: false } });
    const provider = new HttpAddressVerificationProvider({ url: "https://postal.example.com/verify" });
    await provider.verify(INPUT);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ headers: {} })
    );
  });
});

describe("requestAddressVerification (never throws — provider outage fallback)", () => {
  afterEach(() => {
    setAddressVerificationProvider(new NullAddressVerificationProvider());
  });

  it("delegates to the active provider on success", async () => {
    const provider: AddressVerificationProvider = {
      verify: jest.fn().mockResolvedValue({
        available: true,
        valid: true,
        standardized: INPUT,
        providerReference: "ref-1",
        providerName: "usps",
        error: null,
      }),
    };
    setAddressVerificationProvider(provider);

    const result = await requestAddressVerification(INPUT);
    expect(result.valid).toBe(true);
    expect(provider.verify).toHaveBeenCalledWith(INPUT);
  });

  it("normalizes a thrown provider error (outage) into available: false", async () => {
    const provider: AddressVerificationProvider = {
      verify: jest.fn().mockRejectedValue(new Error("provider timed out")),
    };
    setAddressVerificationProvider(provider);

    const result = await requestAddressVerification(INPUT);

    expect(result.available).toBe(false);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("provider timed out");
  });
});
