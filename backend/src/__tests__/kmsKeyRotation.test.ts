// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const KEY_V1 = "1".repeat(64);
const KEY_V2 = "2".repeat(64);

describe("kmsEncryption key rotation", () => {
  it("keeps decrypting documents sealed under a rotated-away key version", () => {
    let activeVersion = "v1";
    jest.doMock("../config.js", () => ({
      loadConfig: () => ({
        kmsKeyVersions: { v1: KEY_V1, v2: KEY_V2 },
        kmsActiveKeyVersion: activeVersion,
      }),
    }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const kms = require("../services/kmsEncryption") as typeof import("../services/kmsEncryption");

    const plaintext = Buffer.from("sealed under v1");
    const envelope = kms.encryptBuffer(plaintext);
    expect(envelope.keyVersion).toBe("v1");

    // Simulate a key rotation: new documents now seal under v2 ...
    activeVersion = "v2";
    const newEnvelope = kms.encryptBuffer(Buffer.from("sealed under v2"));
    expect(newEnvelope.keyVersion).toBe("v2");

    // ... but the old document, still recording keyVersion "v1", must still decrypt correctly.
    expect(kms.decryptBuffer(envelope).equals(plaintext)).toBe(true);
  });
});
