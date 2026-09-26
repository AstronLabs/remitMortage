// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { NextFunction, Request, Response } from "express";
import { encryptBuffer, EnvelopeEncryptedPayload } from "../services/kmsEncryption.js";

export interface KycUploadRequest extends Request {
  file?: Express.Multer.File;
  kycEnvelope?: EnvelopeEncryptedPayload;
}

/**
 * Envelope-encrypts the buffered upload immediately after multer parses it,
 * before any handler forwards the bytes to storage. Downstream code only
 * ever sees `req.kycEnvelope` (ciphertext + wrapped key) — the raw buffer is
 * zeroed out so a bug further down the chain can't accidentally persist or
 * log the plaintext document.
 */
export function encryptKycUpload(req: KycUploadRequest, res: Response, next: NextFunction) {
  if (!req.file) {
    return next();
  }
  try {
    req.kycEnvelope = encryptBuffer(req.file.buffer);
    req.file.buffer = Buffer.alloc(0);
  } catch (error) {
    return next(error);
  }
  next();
}
