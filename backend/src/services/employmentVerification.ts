// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Applicant employment verification (issue #802): an automated payroll-
 * provider faster-path alongside the existing manual document review.
 *
 * `verifyEmployment` never throws and never blocks the applicant — every
 * outcome (verified, employer not covered, provider error) routes cleanly
 * to either an accepted automated result or the existing manual-document
 * path. Only the verification result and the confirmed income figure are
 * persisted (`employmentVerificationStore.ts`), never a payroll credential
 * or pay history.
 */

import { upsertApplicant, getApplicant } from "./db.js";
import { requestPayrollVerification } from "./payrollVerificationProvider.js";
import {
  createEmploymentVerification,
  getLatestEmploymentVerification,
  type EmploymentVerificationMethod,
  type EmploymentVerificationStatus,
} from "./employmentVerificationStore.js";

export interface EmploymentVerificationOutcome {
  status: EmploymentVerificationStatus;
  method: EmploymentVerificationMethod;
  employerName: string | null;
  verifiedMonthlyIncome: number | null;
  verifiedAt: string | null;
  message: string;
}

const NOT_COVERED_MESSAGE =
  "Your employer isn't yet supported for automatic verification. Please upload a pay stub for manual review.";
const FAILED_MESSAGE =
  "Automated employment verification is temporarily unavailable. Please upload a pay stub for manual review.";

export async function verifyEmployment(
  stellarAddress: string,
  employerName: string
): Promise<EmploymentVerificationOutcome> {
  const applicant = await upsertApplicant(stellarAddress, {});
  return verifySource(applicant, stellarAddress, employerName);
}

/** Verifies one income source for an already-resolved applicant — the single-source flow's body. */
async function verifySource(
  applicant: { id: string },
  stellarAddress: string,
  employerName: string
): Promise<EmploymentVerificationOutcome> {
  const result = await requestPayrollVerification({ applicantAddress: stellarAddress, employerName });

  if (result.error) {
    await createEmploymentVerification({
      applicantId: applicant.id,
      method: "MANUAL_DOCUMENT",
      status: "FAILED",
      employerName,
      failureReason: result.error,
    });
    return {
      status: "FAILED",
      method: "MANUAL_DOCUMENT",
      employerName: null,
      verifiedMonthlyIncome: null,
      verifiedAt: null,
      message: FAILED_MESSAGE,
    };
  }

  if (!result.verified) {
    await createEmploymentVerification({
      applicantId: applicant.id,
      method: "MANUAL_DOCUMENT",
      status: "NOT_COVERED",
      employerName,
    });
    return {
      status: "NOT_COVERED",
      method: "MANUAL_DOCUMENT",
      employerName: null,
      verifiedMonthlyIncome: null,
      verifiedAt: null,
      message: NOT_COVERED_MESSAGE,
    };
  }

  const verifiedAt = new Date();
  await createEmploymentVerification({
    applicantId: applicant.id,
    method: "AUTOMATED_PAYROLL",
    status: "VERIFIED",
    employerName: result.employerName ?? employerName,
    verifiedMonthlyIncome: result.verifiedMonthlyIncome,
    providerReference: result.providerReference,
    providerName: result.providerName,
    verifiedAt,
  });

  return {
    status: "VERIFIED",
    method: "AUTOMATED_PAYROLL",
    employerName: result.employerName ?? employerName,
    verifiedMonthlyIncome: result.verifiedMonthlyIncome,
    verifiedAt: verifiedAt.toISOString(),
    message: "Employment and income verified automatically.",
  };
}

/** Upper bound on income sources per request, so one call can't fan out unbounded provider requests. */
export const MAX_INCOME_SOURCES = 10;

export interface MultiSourceEmploymentVerificationOutcome {
  sources: EmploymentVerificationOutcome[];
  /** Sum of every automatically verified source's monthly income — the figure used for scoring. */
  combinedVerifiedMonthlyIncome: number;
  verifiedSourceCount: number;
  /** Sources that fell back to manual document review (NOT_COVERED or FAILED). */
  manualReviewSourceCount: number;
}

/**
 * Verifies several income sources (issue #1108) — e.g. two part-time jobs, or
 * a job plus freelance income — in one request. Each source runs independently
 * through the same path as `verifyEmployment`, so a source that falls back to
 * manual review (or even throws unexpectedly) never blocks the others from
 * completing automatically. Outcomes are returned in request order.
 */
export async function verifyEmploymentSources(
  stellarAddress: string,
  employerNames: string[]
): Promise<MultiSourceEmploymentVerificationOutcome> {
  const applicant = await upsertApplicant(stellarAddress, {});

  const settled = await Promise.allSettled(
    employerNames.map((employerName) => verifySource(applicant, stellarAddress, employerName))
  );

  const sources = settled.map((entry): EmploymentVerificationOutcome =>
    entry.status === "fulfilled"
      ? entry.value
      : {
          status: "FAILED",
          method: "MANUAL_DOCUMENT",
          employerName: null,
          verifiedMonthlyIncome: null,
          verifiedAt: null,
          message: FAILED_MESSAGE,
        }
  );

  const verified = sources.filter((s) => s.status === "VERIFIED");
  return {
    sources,
    combinedVerifiedMonthlyIncome: verified.reduce((sum, s) => sum + (s.verifiedMonthlyIncome ?? 0), 0),
    verifiedSourceCount: verified.length,
    manualReviewSourceCount: sources.length - verified.length,
  };
}

/** The applicant's latest verification attempt, or null if none exists (including no applicant yet). */
export async function getEmploymentVerificationStatus(stellarAddress: string) {
  const applicant = await getApplicant(stellarAddress);
  if (!applicant) return null;
  return getLatestEmploymentVerification(applicant.id);
}
