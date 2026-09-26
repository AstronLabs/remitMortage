// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Duplicate applicant SSN/tax ID detection (issue #692).
 *
 * Tax IDs are matched through a keyed HMAC of the normalized value. The raw
 * identifier is never stored in plaintext, never logged, and never returned
 * by the reviewer endpoint: matches are surfaced as applicant and application
 * context only.
 */

import { prisma } from "./db.js";
import { hashTaxId } from "../utils/taxIdHash.js";

export const DUPLICATE_TAX_ID_REVIEW_REASON = "DUPLICATE_TAX_ID";

/**
 * Stores only the keyed hash of an applicant's tax ID so later submissions
 * can be matched against it.
 */
export async function recordApplicantTaxIdHash(stellarAddress: string, raw: string): Promise<void> {
  const taxIdHash = hashTaxId(raw);
  if (!taxIdHash) return;
  await prisma.applicant.update({ where: { stellarAddress }, data: { taxIdHash } });
}

export interface TaxIdMatch {
  applicantId: string;
  stellarAddress: string;
  applicantCreatedAt: Date;
  applications: { id: string; status: string; principal: number; createdAt: Date }[];
}

/**
 * Finds other live applicants whose tax ID matches `raw`. The applicant that
 * owns `excludeStellarAddress` is left out so re-applying never self-matches.
 */
export async function findTaxIdMatches(
  raw: string,
  excludeStellarAddress?: string
): Promise<TaxIdMatch[]> {
  const taxIdHash = hashTaxId(raw);
  if (!taxIdHash) return [];
  return findMatchesByHash(taxIdHash, excludeStellarAddress);
}

async function findMatchesByHash(
  taxIdHash: string,
  excludeStellarAddress?: string
): Promise<TaxIdMatch[]> {
  const applicants = await prisma.applicant.findMany({
    where: {
      taxIdHash,
      deletedAt: null,
      ...(excludeStellarAddress ? { stellarAddress: { not: excludeStellarAddress } } : {}),
    },
    select: {
      id: true,
      stellarAddress: true,
      createdAt: true,
      loanApplications: {
        where: { deletedAt: null },
        select: { id: true, status: true, principal: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      },
    },
  });

  return applicants.map((a: any) => ({
    applicantId: a.id,
    stellarAddress: a.stellarAddress,
    applicantCreatedAt: a.createdAt,
    applications: a.loanApplications,
  }));
}

/**
 * Reviewer context for a loan application: which other applicants share its
 * applicant's tax ID. Returns null when the application does not exist.
 */
export async function getTaxIdMatchesForApplication(applicationId: string) {
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, deletedAt: null },
    select: {
      id: true,
      manualReviewReason: true,
      applicant: { select: { stellarAddress: true, taxIdHash: true } },
    },
  });
  if (!application) return null;

  const { taxIdHash, stellarAddress } = application.applicant;
  const matches = taxIdHash ? await findMatchesByHash(taxIdHash, stellarAddress) : [];

  return {
    applicationId: application.id,
    manualReviewReason: application.manualReviewReason,
    matchedApplicantCount: matches.length,
    matches,
  };
}
