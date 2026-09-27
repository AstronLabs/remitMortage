// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Applicant mailing address verification (issue #791).
 *
 * `verifyAndPersistAddress` is the single entry point: it validates the
 * submitted fields, asks the active postal provider
 * (`addressVerificationProvider.ts`) to standardize the address, and
 * persists exactly one of three outcomes:
 *
 * - STANDARDIZED — the provider confirmed deliverability; the provider's
 *   canonical form is what gets persisted, not what the applicant typed.
 * - NEEDS_REVIEW — the provider reached a verdict and could not confirm the
 *   address is deliverable. The applicant's own input is persisted as-is
 *   (never silently discarded) and flagged for manual review.
 * - UNVERIFIED — the provider could not be reached at all (outage, timeout,
 *   misconfiguration). Same persistence as NEEDS_REVIEW: never blocks the
 *   applicant on a third-party outage, but never silently treats an
 *   unverified address as confirmed either.
 */

import { getApplicantAddress, upsertApplicant } from "./db.js";
import { requestAddressVerification, type AddressInput } from "./addressVerificationProvider.js";

export class AddressValidationError extends Error {}

export type AddressVerificationStatus = "STANDARDIZED" | "NEEDS_REVIEW" | "UNVERIFIED";

export interface AddressVerificationOutcome {
  status: AddressVerificationStatus;
  address: AddressInput;
  message: string;
  providerReference: string | null;
}

const REQUIRED_FIELDS: Array<keyof AddressInput> = ["line1", "city", "state", "postalCode", "country"];

function normalizeInput(raw: Partial<AddressInput>): AddressInput {
  for (const field of REQUIRED_FIELDS) {
    const value = raw[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new AddressValidationError(`${field} is required.`);
    }
  }

  return {
    line1: raw.line1!.trim(),
    line2: raw.line2?.trim() || null,
    city: raw.city!.trim(),
    state: raw.state!.trim(),
    postalCode: raw.postalCode!.trim(),
    country: raw.country!.trim().toUpperCase(),
  };
}

export async function verifyAndPersistAddress(
  stellarAddress: string,
  rawInput: Partial<AddressInput>
): Promise<AddressVerificationOutcome> {
  const input = normalizeInput(rawInput);
  const result = await requestAddressVerification(input);

  let status: AddressVerificationStatus;
  let addressToPersist: AddressInput;
  let message: string;

  if (result.available && result.valid && result.standardized) {
    status = "STANDARDIZED";
    addressToPersist = result.standardized;
    message = "Address verified and standardized.";
  } else if (result.available) {
    status = "NEEDS_REVIEW";
    addressToPersist = input;
    message =
      "We couldn't confirm this address is deliverable. It's been saved and flagged for manual review.";
  } else {
    status = "UNVERIFIED";
    addressToPersist = input;
    message =
      "Address verification is temporarily unavailable. Your address has been saved as entered and flagged for manual review.";
  }

  await upsertApplicant(stellarAddress, {
    addressLine1: addressToPersist.line1,
    addressLine2: addressToPersist.line2 ?? null,
    addressCity: addressToPersist.city,
    addressState: addressToPersist.state,
    addressPostalCode: addressToPersist.postalCode,
    addressCountry: addressToPersist.country,
    addressVerificationStatus: status,
    addressVerificationDetail: result.error,
    addressVerifiedAt: status === "STANDARDIZED" ? new Date() : null,
    addressProviderReference: result.providerReference,
  });

  return { status, address: addressToPersist, message, providerReference: result.providerReference };
}

export async function getAddressVerificationStatus(stellarAddress: string) {
  return getApplicantAddress(stellarAddress);
}
