// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import bs58 from "bs58";
import nacl from "tweetnacl";

export interface DidDocument {
  "@context": string | string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  service?: DidService[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase?: string;
  publicKeyBase58?: string;
  publicKeyHex?: string;
  publicKeyJwk?: Record<string, string>;
}

export interface DidService {
  id: string;
  type: string;
  serviceEndpoint: string | string[];
}

export interface ParsedDid {
  method: string;
  id: string;
  full: string;
}

export interface VerificationProof {
  challenge: string;
  signature: string;
  signerAddress: string;
}

export interface VerifiedDidResult {
  did: string;
  didHash: string;
  method: string;
  verificationMethodType: string;
  verified: boolean;
  publicKeyBytes: Buffer | null;
}

function parseDid(did: string): ParsedDid | null {
  const parts = did.split(":");
  if (parts.length < 3 || parts[0] !== "did") return null;
  return { method: parts[1], id: parts.slice(2).join(":"), full: did };
}

function hashDidDocument(did: string, publicKeyBytes: Buffer): string {
  const hash = crypto.createHash("sha256");
  hash.update(did);
  hash.update(publicKeyBytes);
  return hash.digest("hex");
}

function extractPublicKey(
  vm: VerificationMethod
): Buffer | null {
  if (vm.publicKeyMultibase) {
    const encoded = vm.publicKeyMultibase;
    const prefix = encoded.charAt(0);
    if (prefix === "z") {
      try {
        return Buffer.from(bs58.decode(encoded.slice(1)));
      } catch {
        return null;
      }
    }
    if (prefix === "u") {
      return Buffer.from(encoded.slice(1), "base64url");
    }
    if (prefix === "m") {
      return Buffer.from(encoded.slice(1), "base64");
    }
    return null;
  }

  if (vm.publicKeyBase58) {
    try {
      return Buffer.from(bs58.decode(vm.publicKeyBase58));
    } catch {
      return null;
    }
  }

  if (vm.publicKeyHex) {
    return Buffer.from(vm.publicKeyHex, "hex");
  }

  return null;
}

function verifyEd25519Signature(
  publicKeyBytes: Buffer,
  challenge: string,
  signatureHex: string
): boolean {
  try {
    const messageBytes = Buffer.from(challenge, "utf8");
    const sigBytes = Buffer.from(signatureHex, "hex");
    const pubKey = publicKeyBytes.subarray(0, 32);
    return nacl.sign.detached.verify(
      new Uint8Array(messageBytes),
      new Uint8Array(sigBytes),
      new Uint8Array(pubKey)
    );
  } catch {
    return false;
  }
}

function verifyEcdsaSecp256k1Signature(
  publicKeyBytes: Buffer,
  challenge: string,
  signatureHex: string
): boolean {
  try {
    const verify = crypto.createVerify("SHA256");
    verify.update(challenge);
    verify.end();
    return verify.verify(
      { key: publicKeyBytes, format: "der", type: "spki" },
      signatureHex,
      "hex"
    );
  } catch {
    return false;
  }
}

export function parseDidDocument(
  doc: unknown
): { valid: boolean; doc: DidDocument; errors: string[] } {
  const errors: string[] = [];
  if (!doc || typeof doc !== "object") {
    return { valid: false, doc: {} as DidDocument, errors: ["Document must be an object"] };
  }

  const d = doc as Record<string, unknown>;

  if (!d["@context"]) errors.push('Missing "@context"');
  let didStr: string | undefined;
  if (!d.id || typeof d.id !== "string") {
    errors.push('Missing or invalid "id"');
  } else {
    didStr = d.id;
    if (!didStr.startsWith("did:")) {
      errors.push('"id" must start with "did:"');
    }
    const parsed = parseDid(didStr);
    if (!parsed) errors.push("Invalid DID format");
  }

  if (d.verificationMethod && !Array.isArray(d.verificationMethod)) {
    errors.push('"verificationMethod" must be an array');
  }

  if (
    d.verificationMethod &&
    Array.isArray(d.verificationMethod) &&
    d.verificationMethod.length === 0
  ) {
    errors.push('At least one "verificationMethod" is required');
  }

  return {
    valid: errors.length === 0,
    doc: d as unknown as DidDocument,
    errors,
  };
}

export function verifyDidProof(
  doc: DidDocument,
  proof: VerificationProof
): VerifiedDidResult {
  const parsed = parseDid(doc.id);
  if (!parsed) {
    return {
      did: doc.id,
      didHash: "",
      method: "unknown",
      verificationMethodType: "unknown",
      verified: false,
      publicKeyBytes: null,
    };
  }

  const vms = doc.verificationMethod ?? [];
  let pubKeyBytes: Buffer | null = null;
  let vmType = "unknown";

  for (const vm of vms) {
    const bytes = extractPublicKey(vm);
    if (bytes) {
      pubKeyBytes = bytes;
      vmType = vm.type;
      break;
    }
  }

  if (!pubKeyBytes) {
    return {
      did: doc.id,
      didHash: "",
      method: parsed.method,
      verificationMethodType: vmType,
      verified: false,
      publicKeyBytes: null,
    };
  }

  let verified = false;
  if (vmType.includes("Ed25519") || vmType.includes("ed25519")) {
    verified = verifyEd25519Signature(pubKeyBytes, proof.challenge, proof.signature);
  } else if (vmType.includes("Secp256k1") || vmType.includes("secp256k1") || vmType.includes("Ecdsa")) {
    verified = verifyEcdsaSecp256k1Signature(pubKeyBytes, proof.challenge, proof.signature);
  }

  const didHash = hashDidDocument(doc.id, pubKeyBytes);

  return {
    did: doc.id,
    didHash,
    method: parsed.method,
    verificationMethodType: vmType,
    verified,
    publicKeyBytes: pubKeyBytes,
  };
}

export function createDidChallenge(walletAddress: string): string {
  const random = crypto.randomBytes(32).toString("hex");
  return `did-challenge:${walletAddress}:${random}:${Date.now()}`;
}
