// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import jwt from "jsonwebtoken";
import { loadConfig } from "../config.js";

const SCOPE = "kyc:decrypt";

export interface KycAccessTokenPayload {
  operatorId: string;
  documentId: string;
  scope: typeof SCOPE;
}

/**
 * Issues a short-lived token authorizing a single backend operator to
 * decrypt a single KYC document — modeled on temporary IAM security
 * credentials rather than a long-lived static key.
 */
export function issueKycAccessToken(
  operatorId: string,
  documentId: string
): { token: string; expiresIn: number } {
  const config = loadConfig();
  const payload: KycAccessTokenPayload = { operatorId, documentId, scope: SCOPE };
  const token = jwt.sign(payload, config.kycOperatorSecret, {
    expiresIn: config.kycAccessTokenTtlSeconds,
  });
  return { token, expiresIn: config.kycAccessTokenTtlSeconds };
}

/** Verifies a token grants decrypt access to the specific document being requested. Throws on expiry, bad signature, wrong scope, or mismatched document. */
export function verifyKycAccessToken(token: string, documentId: string): KycAccessTokenPayload {
  const config = loadConfig();
  const decoded = jwt.verify(token, config.kycOperatorSecret) as KycAccessTokenPayload;
  if (decoded.scope !== SCOPE || decoded.documentId !== documentId) {
    throw new Error("Token is not authorized for this document");
  }
  return decoded;
}
