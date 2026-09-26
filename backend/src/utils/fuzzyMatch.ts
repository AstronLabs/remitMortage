// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import logger from "./logger.js";

/**
 * Normalizes a string by converting to lowercase, removing non-alphanumeric characters (except spaces),
 * and collapsing whitespace.
 */
export function normalizeString(str: string | null | undefined): string {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Calculates the Levenshtein distance between two strings.
 * Dynamic programming implementation with O(min(m, n)) space complexity.
 */
export function levenshteinDistance(str1: string, str2: string): number {
  const s1 = normalizeString(str1);
  const s2 = normalizeString(str2);

  if (s1 === s2) return 0;
  if (s1.length === 0) return s2.length;
  if (s2.length === 0) return s1.length;

  let prevRow = Array.from({ length: s2.length + 1 }, (_, i) => i);
  let currRow = new Array(s2.length + 1);

  for (let i = 0; i < s1.length; i++) {
    currRow[0] = i + 1;
    for (let j = 0; j < s2.length; j++) {
      const cost = s1[i] === s2[j] ? 0 : 1;
      currRow[j + 1] = Math.min(
        currRow[j] + 1,        // insertion
        prevRow[j + 1] + 1,    // deletion
        prevRow[j] + cost      // substitution
      );
    }
    prevRow = [...currRow];
  }

  return prevRow[s2.length];
}

/**
 * Calculates a similarity ratio between 0.0 (completely different) and 1.0 (exact match).
 */
export function calculateSimilarityScore(str1: string, str2: string): number {
  const norm1 = normalizeString(str1);
  const norm2 = normalizeString(str2);

  if (!norm1 && !norm2) return 1.0;
  if (!norm1 || !norm2) return 0.0;

  const maxLen = Math.max(norm1.length, norm2.length);
  if (maxLen === 0) return 1.0;

  const dist = levenshteinDistance(norm1, norm2);
  return Number((1 - dist / maxLen).toFixed(4));
}

export interface ApplicantFields {
  id?: string;
  fullName?: string;
  address?: string;
  idDocumentNumber?: string;
  taxId?: string;
}

export interface MatchDetail {
  matchedApplicantId: string;
  overallScore: number;
  fieldScores: {
    fullName?: number;
    address?: number;
    idDocumentNumber?: number;
    taxId?: number;
  };
  matchedFields: string[];
  flaggedForReview: boolean;
}

export const DUP_SIMILARITY_THRESHOLD = 0.80; // 80% similarity threshold

/**
 * Compares an incoming applicant against a candidate applicant across available fields.
 */
export function compareApplicants(
  source: ApplicantFields,
  target: ApplicantFields
): MatchDetail {
  const fieldScores: Record<string, number> = {};
  const matchedFields: string[] = [];
  let totalScoreSum = 0;
  let fieldCount = 0;

  if (source.fullName && target.fullName) {
    const score = calculateSimilarityScore(source.fullName, target.fullName);
    fieldScores.fullName = score;
    if (score >= DUP_SIMILARITY_THRESHOLD) matchedFields.push("fullName");
    totalScoreSum += score;
    fieldCount++;
  }

  if (source.address && target.address) {
    const score = calculateSimilarityScore(source.address, target.address);
    fieldScores.address = score;
    if (score >= DUP_SIMILARITY_THRESHOLD) matchedFields.push("address");
    totalScoreSum += score;
    fieldCount++;
  }

  if (source.idDocumentNumber && target.idDocumentNumber) {
    const score = calculateSimilarityScore(source.idDocumentNumber, target.idDocumentNumber);
    fieldScores.idDocumentNumber = score;
    if (score >= DUP_SIMILARITY_THRESHOLD) matchedFields.push("idDocumentNumber");
    totalScoreSum += score;
    fieldCount++;
  }

  if (source.taxId && target.taxId) {
    const score = calculateSimilarityScore(source.taxId, target.taxId);
    fieldScores.taxId = score;
    if (score >= DUP_SIMILARITY_THRESHOLD) matchedFields.push("taxId");
    totalScoreSum += score;
    fieldCount++;
  }

  const overallScore = fieldCount > 0 ? Number((totalScoreSum / fieldCount).toFixed(4)) : 0;
  const maxFieldScore = Math.max(0, ...Object.values(fieldScores));
  const effectiveScore = Math.max(overallScore, maxFieldScore);
  const flaggedForReview = effectiveScore >= DUP_SIMILARITY_THRESHOLD;

  return {
    matchedApplicantId: target.id ?? "unknown",
    overallScore: effectiveScore,
    fieldScores,
    matchedFields,
    flaggedForReview,
  };
}

export interface ReviewerDecisionLog {
  applicationId: string;
  reviewerId: string;
  decision: "APPROVED" | "REJECTED";
  reason?: string;
  timestamp: string;
}

/**
 * Checks an applicant against a list of existing applicant records for potential duplicates.
 * Logs match scores and flags for manual review if similarity exceeds threshold.
 */
export function checkDuplicateApplicants(
  source: ApplicantFields,
  existingApplicants: ApplicantFields[]
): {
  isDuplicate: boolean;
  status: "PENDING" | "MANUAL_REVIEW";
  highestScore: number;
  matches: MatchDetail[];
} {
  const matches: MatchDetail[] = [];
  let highestScore = 0;

  for (const existing of existingApplicants) {
    if (source.id && existing.id && source.id === existing.id) {
      continue; // skip self
    }

    const detail = compareApplicants(source, existing);
    if (detail.flaggedForReview) {
      matches.push(detail);
      logger.info(
        `High similarity candidate detected for manual review: applicantId=${source.id || "new"}, matchedWith=${existing.id}, score=${detail.overallScore}, fields=${detail.matchedFields.join(",")}`
      );
    }
    if (detail.overallScore > highestScore) {
      highestScore = detail.overallScore;
    }
  }

  const isDuplicate = matches.length > 0;
  return {
    isDuplicate,
    status: isDuplicate ? "MANUAL_REVIEW" : "PENDING",
    highestScore,
    matches,
  };
}

/**
 * Logs a reviewer decision (approval/rejection) for manual review flagged applications.
 */
export function logReviewerDecision(
  applicationId: string,
  reviewerId: string,
  decision: "APPROVED" | "REJECTED",
  reason?: string
): ReviewerDecisionLog {
  const log: ReviewerDecisionLog = {
    applicationId,
    reviewerId,
    decision,
    reason,
    timestamp: new Date().toISOString(),
  };

  logger.info(
    `Manual review decision logged: applicationId=${applicationId}, reviewerId=${reviewerId}, decision=${decision}, reason=${reason || "N/A"}`
  );

  return log;
}
