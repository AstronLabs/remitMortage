// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Keypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import { prisma } from "./db.js";
import { loadConfig } from "../config.js";

const config = loadConfig();

/**
 * Derives a Stellar Keypair from the backend signing secret.
 * This guarantees a stable keypair even if the secret is not a standard Stellar seed.
 */
export function getBackendSigningKeypair(): Keypair {
  const secret = config.backendSigningSecret;
  if (secret.startsWith("S") && secret.length === 56) {
    try {
      return Keypair.fromSecret(secret);
    } catch {
      // Fallback to hashing if it's a malformed secret
    }
  }
  
  const seed = crypto.createHash("sha256").update(secret).digest();
  return Keypair.fromRawEd25519Seed(seed);
}

export interface VerificationProofPayload {
  reportId: string;
  walletAddress: string;
  eligible: boolean;
  creditScore: number | null;
  reportHash: string;
  analyzedAt: string;
}

export interface SignedVerificationProof {
  payload: VerificationProofPayload;
  signature: string;
  publicKey: string;
}

/**
 * Generates a cryptographic proof for a given VerificationResult ID.
 * The proof deliberately strips out any sensitive PII and is signed
 * by the backend's Ed25519 keypair for third-party verification.
 * 
 * @param reportId The ID of the VerificationResult
 * @returns The signed proof object
 */
export async function generateVerificationProof(reportId: string): Promise<SignedVerificationProof> {
  const result = await prisma.verificationResult.findUnique({
    where: { id: reportId },
    include: {
      applicant: true
    }
  });

  if (!result) {
    throw new Error(`VerificationResult not found for id: ${reportId}`);
  }

  const payload: VerificationProofPayload = {
    reportId: result.id,
    walletAddress: result.applicant.stellarAddress,
    eligible: result.eligible,
    creditScore: result.applicant.creditScore,
    reportHash: result.reportHash,
    analyzedAt: result.analyzedAt.toISOString(),
  };

  const payloadString = JSON.stringify(payload);
  const messageBytes = Buffer.from(payloadString, "utf8");

  const keypair = getBackendSigningKeypair();
  const signatureBuffer = keypair.sign(messageBytes);
  const signature = signatureBuffer.toString("hex");

  return {
    payload,
    signature,
    publicKey: keypair.publicKey(),
  };
}
