// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { loadConfig } from "../config.js";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const DATA_KEY_LENGTH = 32;

export interface EnvelopeEncryptedPayload {
  /** base64(iv || authTag || ciphertext) of the file content, encrypted with the data key. */
  ciphertext: string;
  /** base64(iv || authTag || encryptedDataKey) — the data key, wrapped by the KMS key encryption key. */
  wrappedDataKey: string;
  /** KEK rotation version the data key was wrapped under, so old files keep decrypting after rotation. */
  keyVersion: string;
}

function getKeyEncryptionKey(keyVersion: string): Buffer {
  const config = loadConfig();
  const hexKey = config.kmsKeyVersions[keyVersion];
  if (!hexKey) {
    throw new Error(
      `No KMS key material configured for key version "${keyVersion}". Check KMS_KEY_VERSIONS.`
    );
  }
  const buf = Buffer.from(hexKey, "hex");
  if (buf.length !== DATA_KEY_LENGTH) {
    throw new Error(
      `KMS key version "${keyVersion}" must be a 32-byte hex-encoded string (64 hex chars).`
    );
  }
  return buf;
}

function aesGcmEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

function aesGcmDecrypt(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, IV_LENGTH);
  const authTag = sealed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = sealed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

/**
 * Envelope-encrypts a buffer (e.g. an uploaded KYC document): generates a
 * fresh per-file Data Encryption Key (DEK), encrypts the buffer with it, then
 * wraps the DEK with the active KMS-managed Key Encryption Key (KEK). Only
 * the wrapped DEK and ciphertext are ever persisted — the KEK itself never
 * leaves this module, mirroring how a real KMS Encrypt/Decrypt API keeps the
 * master key inside the KMS boundary.
 */
export function encryptBuffer(plaintext: Buffer): EnvelopeEncryptedPayload {
  const config = loadConfig();
  const keyVersion = config.kmsActiveKeyVersion;
  const kek = getKeyEncryptionKey(keyVersion);

  const dataKey = randomBytes(DATA_KEY_LENGTH);
  const ciphertext = aesGcmEncrypt(dataKey, plaintext).toString("base64");
  const wrappedDataKey = aesGcmEncrypt(kek, dataKey).toString("base64");
  dataKey.fill(0);

  return { ciphertext, wrappedDataKey, keyVersion };
}

/** Reverses {@link encryptBuffer}: unwraps the DEK with the KEK version recorded on the payload, then decrypts the ciphertext. */
export function decryptBuffer(payload: EnvelopeEncryptedPayload): Buffer {
  const kek = getKeyEncryptionKey(payload.keyVersion);
  const dataKey = aesGcmDecrypt(kek, Buffer.from(payload.wrappedDataKey, "base64"));
  try {
    return aesGcmDecrypt(dataKey, Buffer.from(payload.ciphertext, "base64"));
  } finally {
    dataKey.fill(0);
  }
}
