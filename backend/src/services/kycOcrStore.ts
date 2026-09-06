/**
 * Persistence layer for KYC OCR results and confirmation state.
 *
 * Uses the shared Prisma singleton from services/db.ts — consistent with every
 * other service in this project.  The KycOcrResult model stores the three OCR-
 * extracted fields and their per-field confirmation flags.
 */

import { prisma } from "./db.js";
import type { OcrResult } from "./ocrService.js";

export interface KycOcrRecord {
  id: string;
  documentId: string;
  applicantAddress: string;
  extractedName: string | null;
  nameConfirmed: boolean;
  extractedIdNumber: string | null;
  idNumberConfirmed: boolean;
  extractedAddress: string | null;
  addressConfirmed: boolean;
  ocrFailed: boolean;
  ocrError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Persists the OCR result for a newly uploaded document.
 * Called immediately after encryption — one record per document.
 */
export async function createOcrResult(
  documentId: string,
  applicantAddress: string,
  result: OcrResult
): Promise<KycOcrRecord> {
  return prisma.kycOcrResult.create({
    data: {
      documentId,
      applicantAddress,
      extractedName: result.fields.name ?? null,
      extractedIdNumber: result.fields.idNumber ?? null,
      extractedAddress: result.fields.address ?? null,
      ocrFailed: !result.success,
      ocrError: result.error ?? null,
    },
  });
}

/**
 * Returns the OCR result for a document, or null if not found.
 */
export async function getOcrResult(documentId: string): Promise<KycOcrRecord | null> {
  return prisma.kycOcrResult.findUnique({ where: { documentId } });
}

export interface ConfirmationPatch {
  confirmName?: boolean;
  confirmIdNumber?: boolean;
  confirmAddress?: boolean;
}

/**
 * Marks one or more OCR-extracted fields as confirmed by the applicant.
 * Only fields explicitly set to true in the patch are updated — existing
 * confirmation state for other fields is preserved.
 */
export async function confirmOcrFields(
  documentId: string,
  patch: ConfirmationPatch
): Promise<KycOcrRecord> {
  const data: Record<string, boolean> = {};
  if (patch.confirmName === true) data.nameConfirmed = true;
  if (patch.confirmIdNumber === true) data.idNumberConfirmed = true;
  if (patch.confirmAddress === true) data.addressConfirmed = true;

  return prisma.kycOcrResult.update({
    where: { documentId },
    data,
  });
}

/**
 * Validates that all OCR-filled fields have been confirmed by the applicant
 * before an onboarding submission is accepted.
 *
 * A field is "required to be confirmed" when OCR successfully extracted it
 * (it is not null) AND the applicant has not yet confirmed it.
 *
 * Returns an array of field names that are still unconfirmed.
 * Returns an empty array when no confirmation is required (either OCR failed
 * to extract any fields, or all extracted fields have been confirmed).
 */
export function getUnconfirmedFields(record: KycOcrRecord): string[] {
  const unconfirmed: string[] = [];
  if (record.extractedName !== null && !record.nameConfirmed) {
    unconfirmed.push("name");
  }
  if (record.extractedIdNumber !== null && !record.idNumberConfirmed) {
    unconfirmed.push("idNumber");
  }
  if (record.extractedAddress !== null && !record.addressConfirmed) {
    unconfirmed.push("address");
  }
  return unconfirmed;
}
