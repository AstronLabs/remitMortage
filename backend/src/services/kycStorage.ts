// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { EnvelopeEncryptedPayload } from "./kmsEncryption.js";

export interface KycDocumentRecord {
  documentId: string;
  applicantAddress: string;
  originalName: string;
  mimeType: string;
  uploadedAt: string;
  envelope: EnvelopeEncryptedPayload;
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
  originalName: string,
  mimeType: string,
  envelope: EnvelopeEncryptedPayload
): Promise<KycDocumentRecord> {
  await ensureStorageDir();
  const record: KycDocumentRecord = {
    documentId: crypto.randomUUID(),
    applicantAddress,
    originalName,
    mimeType,
    uploadedAt: new Date().toISOString(),
    envelope,
  };
  await fs.writeFile(recordPath(record.documentId), JSON.stringify(record), "utf8");
  return record;
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
