// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Postal address verification/standardization (issue #791).
 *
 * Interface + Null default + Http implementation + settable singleton,
 * mirroring the injectable-provider shape used elsewhere in this backend
 * (e.g. the OCR provider in `ocrService.ts`) so a real provider (USPS,
 * SmartyStreets, Lob, etc.) can be swapped in via config, and tests can
 * inject a mock without touching the network.
 *
 * `requestAddressVerification` is the orchestration entry point: it never
 * throws, always returning a structured result whose `available` flag
 * distinguishes "the provider ran and said this address is/isn't
 * deliverable" from "the provider could not be reached at all" — the two
 * distinct outcomes `services/addressVerification.ts` needs to tell a
 * genuinely bad address apart from a provider outage.
 */

import axios from "axios";
import logger from "../utils/logger.js";
import { recordApiCapabilityUsage } from "./apiScopeUsageTracker.js";

export interface AddressInput {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

export interface AddressVerificationProviderResult {
  /** False when the provider could not be reached/errored/timed out — distinct from a reachable "not deliverable" verdict. */
  available: boolean;
  /** Whether the provider considers the address deliverable. Only meaningful when `available` is true. */
  valid: boolean;
  /** Canonical/standardized form. Present only when `valid` is true. */
  standardized: AddressInput | null;
  providerReference: string | null;
  providerName: string | null;
  error: string | null;
}

export interface AddressVerificationProvider {
  verify(input: AddressInput): Promise<AddressVerificationProviderResult>;
}

/** Safe zero-config default: never claims to have verified anything. */
export class NullAddressVerificationProvider implements AddressVerificationProvider {
  async verify(): Promise<AddressVerificationProviderResult> {
    return {
      available: false,
      valid: false,
      standardized: null,
      providerReference: null,
      providerName: null,
      error: null,
    };
  }
}

export interface HttpAddressVerificationProviderOptions {
  url: string;
  apiKey?: string | null;
  /** Label recorded on results, e.g. "usps". Defaults to "http_address_provider". */
  providerName?: string;
  timeoutMs?: number;
}

function pickStandardized(body: any): AddressInput | null {
  const raw = body?.standardizedAddress ?? body?.address;
  if (!raw || typeof raw !== "object") return null;

  const line1 = raw.line1 ?? raw.address1 ?? raw.streetAddress;
  const city = raw.city;
  const state = raw.state ?? raw.stateAbbreviation;
  const postalCode = raw.postalCode ?? raw.zip ?? raw.zipCode;
  const country = raw.country ?? raw.countryCode;

  if (!line1 || !city || !state || !postalCode || !country) return null;

  return {
    line1,
    line2: raw.line2 ?? raw.address2 ?? null,
    city,
    state,
    postalCode,
    country,
  };
}

export class HttpAddressVerificationProvider implements AddressVerificationProvider {
  constructor(private readonly options: HttpAddressVerificationProviderOptions) {}

  async verify(input: AddressInput): Promise<AddressVerificationProviderResult> {
    const providerName = this.options.providerName ?? "http_address_provider";

    const response = await axios.post(
      this.options.url,
      { address: input },
      {
        timeout: this.options.timeoutMs ?? 10_000,
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
      }
    );

    void recordApiCapabilityUsage("usps_address", "verify").catch(() => {});

    const body = response.data ?? {};
    if (!body.deliverable) {
      return {
        available: true,
        valid: false,
        standardized: null,
        providerReference: body.referenceId ?? null,
        providerName,
        error: null,
      };
    }

    const standardized = pickStandardized(body);
    if (!standardized) {
      // The provider said "deliverable" but didn't return a usable canonical
      // form — treat as un-standardizable rather than trusting a guess.
      return {
        available: true,
        valid: false,
        standardized: null,
        providerReference: body.referenceId ?? null,
        providerName,
        error: "Provider reported deliverable but returned no usable standardized address.",
      };
    }

    return {
      available: true,
      valid: true,
      standardized,
      providerReference: body.referenceId ?? null,
      providerName,
      error: null,
    };
  }
}

let activeProvider: AddressVerificationProvider = new NullAddressVerificationProvider();

export function setAddressVerificationProvider(provider: AddressVerificationProvider): void {
  activeProvider = provider;
}

export function getAddressVerificationProvider(): AddressVerificationProvider {
  return activeProvider;
}

/**
 * Runs the active provider and never throws. A transport error, timeout, or
 * any other exception is normalized into `available: false` so callers can
 * treat it identically to "provider not configured" — both mean "route to
 * manual review, don't block the applicant."
 */
export async function requestAddressVerification(
  input: AddressInput
): Promise<AddressVerificationProviderResult> {
  try {
    return await activeProvider.verify(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[address-verification] Provider call failed", { error: message });
    return {
      available: false,
      valid: false,
      standardized: null,
      providerReference: null,
      providerName: null,
      error: message,
    };
  }
}
