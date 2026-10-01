// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Persistence for employment verification attempts (issue #802).
 *
 * Only the verification result and the income figure itself are stored —
 * never a raw payroll credential or full pay history, and never more than
 * one income figure per attempt. `verifiedMonthlyIncome` is encrypted at
 * rest with the same primitive `Applicant.monthlyIncome` uses.
 */

import { prisma } from "./db.js";
import { encrypt, decrypt } from "../utils/crypto.js";

export type EmploymentVerificationMethod = "AUTOMATED_PAYROLL" | "MANUAL_DOCUMENT";
export type EmploymentVerificationStatus = "VERIFIED" | "NOT_COVERED" | "FAILED";

export interface CreateEmploymentVerificationInput {
  applicantId: string;
  method: EmploymentVerificationMethod;
  status: EmploymentVerificationStatus;
  employerName?: string | null;
  verifiedMonthlyIncome?: number | null;
  providerReference?: string | null;
  providerName?: string | null;
  failureReason?: string | null;
  verifiedAt?: Date | null;
}

function decryptRecord<T extends { verifiedMonthlyIncome: string | null }>(record: T | null): T | null {
  if (!record) return record;
  return {
    ...record,
    verifiedMonthlyIncome: record.verifiedMonthlyIncome !== null ? decrypt(record.verifiedMonthlyIncome) : null,
  };
}

export async function createEmploymentVerification(input: CreateEmploymentVerificationInput) {
  const record = await (prisma as any).employmentVerification.create({
    data: {
      applicantId: input.applicantId,
      method: input.method,
      status: input.status,
      employerName: input.employerName ?? null,
      verifiedMonthlyIncome:
        input.verifiedMonthlyIncome !== undefined && input.verifiedMonthlyIncome !== null
          ? encrypt(String(input.verifiedMonthlyIncome))
          : null,
      providerReference: input.providerReference ?? null,
      providerName: input.providerName ?? null,
      failureReason: input.failureReason ?? null,
      verifiedAt: input.verifiedAt ?? null,
    },
  });
  return decryptRecord(record);
}

/** Most recent verification attempt for an applicant, or null if none exists. */
export async function getLatestEmploymentVerification(applicantId: string) {
  const record = await (prisma as any).employmentVerification.findFirst({
    where: { applicantId },
    orderBy: { createdAt: "desc" },
  });
  return decryptRecord(record);
}
