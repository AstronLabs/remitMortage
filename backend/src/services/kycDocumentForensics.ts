// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Runs and records the metadata forgery analysis for uploaded KYC documents
 * (issue #813). The pure analysis lives in `documentForensics.ts`; this
 * module persists its verdict, logs the specific triggering signals, and
 * gives reviewers a queue of flagged documents to resolve.
 *
 * A flag routes the document to manual review — it never rejects the upload
 * or blocks the applicant, because legitimate scans can lack rich metadata.
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";
import { analyzeDocumentMetadata, type ForensicAnalysis, type ForensicSignal } from "./documentForensics.js";

export type ReviewOutcome = "CLEARED" | "CONFIRMED_TAMPERED";
const REVIEW_OUTCOMES: ReviewOutcome[] = ["CLEARED", "CONFIRMED_TAMPERED"];

export class ForensicsReviewError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid_outcome" | "not_found" | "not_flagged" | "already_reviewed"
  ) {
    super(message);
  }
}

export interface RecordedForensics {
  documentId: string;
  format: string;
  flagged: boolean;
  signals: ForensicSignal[];
}

/**
 * Analyzes a plaintext document buffer and records the result. Never throws:
 * the upload has already succeeded by the time this runs, and an analysis or
 * storage problem must not fail it.
 */
export async function analyzeAndRecordDocument(input: {
  documentId: string;
  applicantAddress: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<RecordedForensics | null> {
  const { documentId, applicantAddress, buffer, mimeType } = input;

  let analysis: ForensicAnalysis;
  try {
    analysis = analyzeDocumentMetadata(buffer, mimeType);
  } catch (err) {
    logger.error("[KYC] Document forensics analysis failed", { documentId, err });
    return null;
  }

  if (analysis.flagged) {
    // The specific signals are logged so a reviewer (or an on-call engineer
    // reading logs) knows what to look for, not just that something was off.
    logger.warn("[KYC] Document flagged for manual review: suspicious metadata", {
      documentId,
      applicantAddress,
      format: analysis.format,
      signals: analysis.signals.map((s) => ({
        code: s.code,
        severity: s.severity,
        evidence: s.evidence,
      })),
    });
  }

  try {
    await (prisma as any).kycDocumentForensics.create({
      data: {
        documentId,
        applicantAddress,
        format: analysis.format,
        flagged: analysis.flagged,
        signals: analysis.signals,
      },
    });
    if (analysis.flagged) {
      await (prisma as any).auditLog?.create?.({
        data: {
          action: "KYC_DOCUMENT_FLAGGED",
          actorAddress: "system:forensics",
          metadata: {
            documentId,
            applicantAddress,
            signalCodes: analysis.signals.map((s) => s.code),
          },
        },
      });
    }
  } catch (err) {
    logger.error("[KYC] Failed to record document forensics", { documentId, err });
  }

  return {
    documentId,
    format: analysis.format,
    flagged: analysis.flagged,
    signals: analysis.signals,
  };
}

/** Flagged documents still awaiting a reviewer, oldest first. */
export async function listFlaggedDocuments(limit = 100) {
  return (prisma as any).kycDocumentForensics.findMany({
    where: { flagged: true, reviewedAt: null },
    orderBy: { analyzedAt: "asc" },
    take: limit,
  });
}

/** A reviewer's resolution of a flagged document. Each document is resolved once. */
export async function reviewFlaggedDocument(input: {
  documentId: string;
  reviewedBy: string;
  outcome: string;
  note?: string | null;
}) {
  if (!REVIEW_OUTCOMES.includes(input.outcome as ReviewOutcome)) {
    throw new ForensicsReviewError(
      `outcome must be one of ${REVIEW_OUTCOMES.join(", ")}.`,
      "invalid_outcome"
    );
  }

  const record = await (prisma as any).kycDocumentForensics.findUnique({
    where: { documentId: input.documentId },
  });
  if (!record) throw new ForensicsReviewError("Document analysis not found.", "not_found");
  if (!record.flagged) {
    throw new ForensicsReviewError("Document was not flagged for review.", "not_flagged");
  }
  if (record.reviewedAt) {
    throw new ForensicsReviewError("Document has already been reviewed.", "already_reviewed");
  }

  return (prisma as any).kycDocumentForensics.update({
    where: { documentId: input.documentId },
    data: {
      reviewedAt: new Date(),
      reviewedBy: input.reviewedBy,
      reviewOutcome: input.outcome,
      reviewNote: input.note ?? null,
    },
  });
}
