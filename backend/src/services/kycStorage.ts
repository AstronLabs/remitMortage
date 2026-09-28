// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { EnvelopeEncryptedPayload } from "./kmsEncryption.js";

export interface KycDocumentRecord {
  documentId: string;
  applicantAddress: string;
  documentType: string;
  status: KycDocumentStatus;
  reviewMessage?: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  envelope: EnvelopeEncryptedPayload;
}

export type KycDocumentStatus = "Uploaded" | "Under Review" | "Accepted" | "Rejected";

export interface ApplicantKycDocument {
  documentId: string;
  applicantAddress: string;
  documentType: string;
  status: KycDocumentStatus;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  reviewMessage?: string;
}

/**
 * Stands in for a private cloud storage bucket (e.g. S3/GCS with public
 * access blocked). Only envelope-encrypted payloads are ever written here —
 * callers must encrypt via kmsEncryption before calling storeEncryptedDocument.
 * The on-disk record shape mirrors what a bucket object + metadata would
 * hold, so swapping this for a real bucket client later is a drop-in change.
 */
function getStorageDir(): string {
  return process.env.KYC_STORAGE_DIR || path.join(process.cwd(), "storage", "kyc-private");
}

async function ensureStorageDir(): Promise<string> {
  const dir = getStorageDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function recordPath(documentId: string): string {
  return path.join(getStorageDir(), `${documentId}.json`);
}

export async function storeEncryptedDocument(
  applicantAddress: string,
  documentType: string,
  originalName: string,
  mimeType: string,
  envelope: EnvelopeEncryptedPayload
): Promise<KycDocumentRecord> {
  await ensureStorageDir();
  const record: KycDocumentRecord = {
    documentId: crypto.randomUUID(),
    applicantAddress,
    documentType,
    status: "Uploaded",
    originalName,
    mimeType,
    uploadedAt: new Date().toISOString(),
    envelope,
  };
  await fs.writeFile(recordPath(record.documentId), JSON.stringify(record), "utf8");
  return record;
}

/** Lists safe, non-sensitive metadata for one applicant's uploaded documents. */
export async function listApplicantDocuments(
  applicantAddress: string
): Promise<ApplicantKycDocument[]> {
  const dir = getStorageDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as KycDocumentRecord;
      if (record.applicantAddress !== applicantAddress) return null;
      return {
        documentId: record.documentId,
        applicantAddress: record.applicantAddress,
        documentType: record.documentType ?? "identity",
        status: record.status ?? "Uploaded",
        originalName: record.originalName,
        mimeType: record.mimeType,
        uploadedAt: record.uploadedAt,
        ...(record.reviewMessage ? { reviewMessage: record.reviewMessage } : {}),
      } satisfies ApplicantKycDocument;
    } catch {
      return null;
    }
  }));
  return records.filter((record): record is ApplicantKycDocument => record !== null);
}

/** Update review state while retaining ciphertext and upload metadata. */
export async function updateDocumentReview(
  documentId: string,
  status: KycDocumentStatus,
  reviewMessage?: string
): Promise<ApplicantKycDocument | null> {
  const record = await getEncryptedDocument(documentId);
  if (!record) return null;
  const updated: KycDocumentRecord & { reviewMessage?: string } = {
    ...record,
    status,
    ...(reviewMessage ? { reviewMessage } : { reviewMessage: undefined }),
  };
  await fs.writeFile(recordPath(documentId), JSON.stringify(updated), "utf8");
  const { envelope: _envelope, ...safeRecord } = updated;
  return safeRecord;
}

export async function listAllApplicantDocuments(): Promise<ApplicantKycDocument[]> {
  const dir = getStorageDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
    const records = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const record = JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as KycDocumentRecord;
        return {
          documentId: record.documentId,
          applicantAddress: record.applicantAddress,
          documentType: record.documentType ?? "identity",
          status: record.status ?? "Uploaded",
          originalName: record.originalName,
          mimeType: record.mimeType,
          uploadedAt: record.uploadedAt,
          ...(record.reviewMessage ? { reviewMessage: record.reviewMessage } : {}),
        } satisfies ApplicantKycDocument;
      } catch {
        return null;
      }
    }));
    return records.filter((record): record is ApplicantKycDocument => record !== null);
}

export async function getEncryptedDocument(documentId: string): Promise<KycDocumentRecord | null> {
  try {
    const raw = await fs.readFile(recordPath(documentId), "utf8");
    return JSON.parse(raw) as KycDocumentRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
