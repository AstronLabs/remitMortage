// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for applicant address verification (issue #791).
 *
 * Acceptance criteria under test:
 * 1. A submitted address is standardized against the postal provider's
 *    canonical format before being persisted.
 * 2. An address the provider can't validate is flagged for review instead
 *    of silently accepted or silently rejected.
 * Plus the ticket's explicit third scenario: provider outage fallback.
 */

const upsertApplicantMock = jest.fn();
jest.mock("../services/db.js", () => ({
  upsertApplicant: (...args: unknown[]) => upsertApplicantMock(...args),
  getApplicantAddress: jest.fn(),
}));

const requestAddressVerificationMock = jest.fn();
jest.mock("../services/addressVerificationProvider.js", () => ({
  requestAddressVerification: (...args: unknown[]) => requestAddressVerificationMock(...args),
}));

import { AddressValidationError, verifyAndPersistAddress } from "../services/addressVerification.js";

const ADDRESS = "GAPPLICANT1111111111111111111111111111111111111111111";
const RAW_INPUT = {
  line1: "123 main st",
  city: "springfield",
  state: "il",
  postalCode: "62704",
  country: "us",
};

beforeEach(() => {
  jest.clearAllMocks();
  upsertApplicantMock.mockResolvedValue({});
});

describe("verifyAndPersistAddress — input validation", () => {
  it.each(["line1", "city", "state", "postalCode", "country"] as const)(
    "rejects a submission missing %s",
    async (field) => {
      const input = { ...RAW_INPUT, [field]: "" };
      await expect(verifyAndPersistAddress(ADDRESS, input)).rejects.toBeInstanceOf(
        AddressValidationError
      );
      expect(requestAddressVerificationMock).not.toHaveBeenCalled();
      expect(upsertApplicantMock).not.toHaveBeenCalled();
    }
  );
});

describe("verifyAndPersistAddress — standardization (acceptance criterion 1)", () => {
  it("persists the provider's canonical form, not the applicant's raw input", async () => {
    const standardized = {
      line1: "123 MAIN ST",
      line2: null,
      city: "SPRINGFIELD",
      state: "IL",
      postalCode: "62704-1234",
      country: "US",
    };
    requestAddressVerificationMock.mockResolvedValue({
      available: true,
      valid: true,
      standardized,
      providerReference: "usps-ref-1",
      providerName: "usps",
      error: null,
    });

    const outcome = await verifyAndPersistAddress(ADDRESS, RAW_INPUT);

    expect(outcome.status).toBe("STANDARDIZED");
    expect(outcome.address).toEqual(standardized);

    expect(upsertApplicantMock).toHaveBeenCalledWith(
      ADDRESS,
      expect.objectContaining({
        addressLine1: "123 MAIN ST",
        addressCity: "SPRINGFIELD",
        addressState: "IL",
        addressPostalCode: "62704-1234",
        addressCountry: "US",
        addressVerificationStatus: "STANDARDIZED",
        addressProviderReference: "usps-ref-1",
      })
    );
    const persisted = upsertApplicantMock.mock.calls[0][1];
    expect(persisted.addressVerifiedAt).toBeInstanceOf(Date);
  });
});

describe("verifyAndPersistAddress — undeliverable address flagging (acceptance criterion 2)", () => {
  it("flags for review and persists the applicant's own input, never silently accepting or rejecting", async () => {
    requestAddressVerificationMock.mockResolvedValue({
      available: true,
      valid: false,
      standardized: null,
      providerReference: "usps-ref-2",
      providerName: "usps",
      error: null,
    });

    const outcome = await verifyAndPersistAddress(ADDRESS, RAW_INPUT);

    expect(outcome.status).toBe("NEEDS_REVIEW");
    // The submission is neither silently rejected (it's returned/persisted)...
    expect(outcome.address.line1).toBe("123 main st");
    expect(outcome.message).toMatch(/manual review/i);

    // ...nor silently accepted as confirmed (verifiedAt stays unset).
    const persisted = upsertApplicantMock.mock.calls[0][1];
    expect(persisted.addressVerificationStatus).toBe("NEEDS_REVIEW");
    expect(persisted.addressVerifiedAt).toBeNull();
    expect(persisted.addressLine1).toBe("123 main st");
  });
});

describe("verifyAndPersistAddress — provider outage fallback (ticket's third test scenario)", () => {
  it("saves the raw address and flags UNVERIFIED when the provider is unreachable, without blocking the applicant", async () => {
    requestAddressVerificationMock.mockResolvedValue({
      available: false,
      valid: false,
      standardized: null,
      providerReference: null,
      providerName: null,
      error: "connect ETIMEDOUT",
    });

    const outcome = await verifyAndPersistAddress(ADDRESS, RAW_INPUT);

    expect(outcome.status).toBe("UNVERIFIED");
    expect(outcome.message).toMatch(/temporarily unavailable/i);

    const persisted = upsertApplicantMock.mock.calls[0][1];
    expect(persisted.addressVerificationStatus).toBe("UNVERIFIED");
    expect(persisted.addressVerificationDetail).toBe("connect ETIMEDOUT");
    expect(persisted.addressVerifiedAt).toBeNull();
    expect(persisted.addressLine1).toBe("123 main st");
  });

  it("distinguishes an outage (UNVERIFIED) from a reachable-but-undeliverable verdict (NEEDS_REVIEW)", async () => {
    requestAddressVerificationMock.mockResolvedValue({
      available: false,
      valid: false,
      standardized: null,
      providerReference: null,
      providerName: null,
      error: "network error",
    });
    const outage = await verifyAndPersistAddress(ADDRESS, RAW_INPUT);

    requestAddressVerificationMock.mockResolvedValue({
      available: true,
      valid: false,
      standardized: null,
      providerReference: null,
      providerName: "usps",
      error: null,
    });
    const undeliverable = await verifyAndPersistAddress(ADDRESS, RAW_INPUT);

    expect(outage.status).toBe("UNVERIFIED");
    expect(undeliverable.status).toBe("NEEDS_REVIEW");
  });
});
