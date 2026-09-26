// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  parseDidDocument,
  verifyDidProof,
  createDidChallenge,
} from "../services/did.js";

function generateKeyPair() {
  return nacl.sign.keyPair();
}

const VALID_DID_DOCUMENT = {
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1",
  ],
  id: "did:stellar:GBADDRESS123456789",
  verificationMethod: [
    {
      id: "did:stellar:GBADDRESS123456789#keys-1",
      type: "Ed25519VerificationKey2020",
      controller: "did:stellar:GBADDRESS123456789",
      publicKeyMultibase: "",
    },
  ],
  authentication: ["did:stellar:GBADDRESS123456789#keys-1"],
  assertionMethod: ["did:stellar:GBADDRESS123456789#keys-1"],
};

describe("parseDidDocument", () => {
  it("returns valid for a well-formed DID document", () => {
    const result = parseDidDocument(VALID_DID_DOCUMENT);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.doc.id).toBe("did:stellar:GBADDRESS123456789");
  });

  it("rejects a null document", () => {
    const result = parseDidDocument(null);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a document missing @context", () => {
    const { "@context": _, ...noContext } = VALID_DID_DOCUMENT;
    const result = parseDidDocument(noContext);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing "@context"');
  });

  it("rejects a document missing id", () => {
    const { id: _id, ...noId } = VALID_DID_DOCUMENT;
    const result = parseDidDocument(noId);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing or invalid "id"');
  });

  it("rejects a document with invalid id (not starting with did:)", () => {
    const result = parseDidDocument({ ...VALID_DID_DOCUMENT, id: "not-a-did" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('"id" must start with "did:"');
  });
});

describe("verifyDidProof", () => {
  it("fails verification when no public key is extractable", () => {
    const doc = {
      ...VALID_DID_DOCUMENT,
      verificationMethod: [
        {
          id: "did:stellar:GBADDRESS123456789#keys-1",
          type: "Ed25519VerificationKey2020",
          controller: "did:stellar:GBADDRESS123456789",
        },
      ],
    };

    const result = verifyDidProof(doc, {
      challenge: "test-challenge",
      signature: "0xdeadbeef",
      signerAddress: "GBADDRESS123456789",
    });

    expect(result.verified).toBe(false);
    expect(result.publicKeyBytes).toBeNull();
  });

  it("verifies a valid Ed25519 signature from publicKeyBase58", () => {
    const keypair = generateKeyPair();
    const pubKeyBase58 = bs58.encode(Buffer.from(keypair.publicKey));
    const challenge = createDidChallenge("GBADDRESS123456789");
    const messageBytes = Buffer.from(challenge, "utf8");
    const signature = nacl.sign.detached(
      new Uint8Array(messageBytes),
      keypair.secretKey
    );
    const signatureHex = Buffer.from(signature).toString("hex");

    const doc = {
      ...VALID_DID_DOCUMENT,
      verificationMethod: [
        {
          id: "did:stellar:GBADDRESS123456789#keys-1",
          type: "Ed25519VerificationKey2020",
          controller: "did:stellar:GBADDRESS123456789",
          publicKeyBase58: pubKeyBase58,
        },
      ],
    };

    const result = verifyDidProof(doc, {
      challenge,
      signature: signatureHex,
      signerAddress: "GBADDRESS123456789",
    });

    expect(result.verified).toBe(true);
    expect(result.did).toBe("did:stellar:GBADDRESS123456789");
    expect(result.didHash).toBeTruthy();
    expect(result.method).toBe("stellar");
  });
});

describe("createDidChallenge", () => {
  it("returns a challenge string containing the wallet address", () => {
    const challenge = createDidChallenge("GBADDR_TEST");
    expect(challenge).toContain("did-challenge:");
    expect(challenge).toContain("GBADDR_TEST");
  });

  it("returns different challenges on successive calls", () => {
    const a = createDidChallenge("GBADDR1");
    const b = createDidChallenge("GBADDR1");
    expect(a).not.toBe(b);
  });
});
