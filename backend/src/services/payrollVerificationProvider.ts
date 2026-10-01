// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Third-party payroll/income verification (issue #802) — an automated
 * faster-path alongside manual pay-stub review, for applicants whose
 * employer participates with the configured provider (Plaid Income, The
 * Work Number, etc.).
 *
 * Interface + Null default + Http implementation + settable singleton,
 * mirroring this codebase's injectable-provider idiom (see
 * `kycProviderFailover.ts`'s `HttpKycProvider`). Only the wallet address and
 * the employer name the applicant supplied are ever sent to the provider —
 * never a raw payroll credential.
 */

import axios from "axios";
import logger from "../utils/logger.js";

export interface PayrollVerificationRequest {
  applicantAddress: string;
  employerName: string;
}

export interface PayrollVerificationResult {
  /** True when the provider has a relationship with this employer at all. */
  covered: boolean;
  /** True only when the provider both covers the employer and confirmed this applicant's income. */
  verified: boolean;
  employerName: string | null;
  verifiedMonthlyIncome: number | null;
  providerReference: string | null;
  providerName: string | null;
  error: string | null;
}

export interface PayrollVerificationProvider {
  verify(request: PayrollVerificationRequest): Promise<PayrollVerificationResult>;
}

/** Safe zero-config default: every employer is reported as not covered. */
export class NullPayrollVerificationProvider implements PayrollVerificationProvider {
  async verify(): Promise<PayrollVerificationResult> {
    return {
      covered: false,
      verified: false,
      employerName: null,
      verifiedMonthlyIncome: null,
      providerReference: null,
      providerName: null,
      error: null,
    };
  }
}

export interface HttpPayrollVerificationProviderOptions {
  url: string;
  apiKey?: string | null;
  /** Label recorded on results, e.g. "the_work_number". */
  providerName?: string;
  timeoutMs?: number;
}

export class HttpPayrollVerificationProvider implements PayrollVerificationProvider {
  constructor(private readonly options: HttpPayrollVerificationProviderOptions) {}

  async verify(request: PayrollVerificationRequest): Promise<PayrollVerificationResult> {
    const response = await axios.post(
      this.options.url,
      { employerName: request.employerName, applicantReference: request.applicantAddress },
      {
        timeout: this.options.timeoutMs ?? 10_000,
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
      }
    );

    const body = response.data ?? {};
    const covered = Boolean(body.covered);
    const income = typeof body.monthlyIncome === "number" ? body.monthlyIncome : null;
    // "Verified" requires the provider to both cover the employer AND return
    // an actual income figure for this specific applicant — a covered
    // employer with no confirmed figure is not a verification.
    const verified = covered && Boolean(body.verified) && income !== null;

    return {
      covered,
      verified,
      employerName: verified ? body.employerName ?? null : null,
      verifiedMonthlyIncome: verified ? income : null,
      providerReference: body.referenceId ?? null,
      providerName: this.options.providerName ?? null,
      error: null,
    };
  }
}

let activeProvider: PayrollVerificationProvider = new NullPayrollVerificationProvider();

export function setPayrollVerificationProvider(provider: PayrollVerificationProvider): void {
  activeProvider = provider;
}

export function getPayrollVerificationProvider(): PayrollVerificationProvider {
  return activeProvider;
}

/**
 * Runs the active provider and never throws. A transport error, timeout, or
 * any other exception is normalized into a non-covered result with `error`
 * set, so callers route to manual review exactly as they would for an
 * employer the provider has never heard of.
 */
export async function requestPayrollVerification(
  request: PayrollVerificationRequest
): Promise<PayrollVerificationResult> {
  try {
    return await activeProvider.verify(request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("[payroll-verification] Provider call failed", { error: message });
    return {
      covered: false,
      verified: false,
      employerName: null,
      verifiedMonthlyIncome: null,
      providerReference: null,
      providerName: null,
      error: message,
    };
  }
}
