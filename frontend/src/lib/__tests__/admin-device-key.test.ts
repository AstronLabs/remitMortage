// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Browser-side device key for admin sessions (issue #886).
 *
 * The tests that matter most verify a produced proof against the *exported*
 * public key — the same bytes the server stores — over a canonical string
 * rebuilt independently. If the client and server proof formats ever drift
 * apart, these fail rather than every admin request failing in staging.
 */

import { webcrypto } from "node:crypto";

import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIMESTAMP_HEADER,
  canonicalProofString,
  createMemoryStore,
  createNonce,
  enrollThisDevice,
  exportPublicKeyBase64,
  forgetDeviceKey,
  getOrCreateDeviceKeyPair,
  getStoredDeviceId,
  setDeviceKeyStore,
  sha256Hex,
  signAdminRequest,
} from "../admin-device-key";

// jsdom ships no SubtleCrypto; Node's WebCrypto supports Ed25519, which is the
// same primitive the browser exposes.
const originalCrypto = globalThis.crypto;

beforeAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: originalCrypto,
  });
});

beforeEach(() => {
  setDeviceKeyStore(createMemoryStore());
});

/**
 * Re-imports the public key from its exported base64 form — i.e. from exactly
 * the bytes `enrollThisDevice` sends and the server stores — so a verification
 * failure means the export path is wrong, not just that signing works.
 */
async function importExportedPublicKey(keyPair: CryptoKeyPair): Promise<CryptoKey> {
  return webcrypto.subtle.importKey(
    "raw",
    Buffer.from(await exportPublicKeyBase64(keyPair), "base64"),
    { name: "Ed25519" },
    true,
    ["verify"]
  );
}

describe("getOrCreateDeviceKeyPair", () => {
  it("generates a non-extractable private key", async () => {
    const keyPair = await getOrCreateDeviceKeyPair();

    expect(keyPair.privateKey.extractable).toBe(false);
    expect(keyPair.privateKey.usages).toContain("sign");
    // The whole premise: the private half cannot be read out, so it cannot be
    // copied the way a cookie can.
    await expect(webcrypto.subtle.exportKey("raw", keyPair.privateKey)).rejects.toThrow();
  });

  it("reuses the stored keypair on later calls", async () => {
    const first = await getOrCreateDeviceKeyPair();
    const second = await getOrCreateDeviceKeyPair();

    expect(await exportPublicKeyBase64(second)).toBe(await exportPublicKeyBase64(first));
  });

  it("generates a fresh key after the device is forgotten", async () => {
    const before = await exportPublicKeyBase64(await getOrCreateDeviceKeyPair());
    await forgetDeviceKey();
    const after = await exportPublicKeyBase64(await getOrCreateDeviceKeyPair());

    expect(after).not.toBe(before);
  });
});

describe("exportPublicKeyBase64", () => {
  it("produces the 32-byte base64 form the enrol endpoint expects", async () => {
    const encoded = await exportPublicKeyBase64(await getOrCreateDeviceKeyPair());

    expect(Buffer.from(encoded, "base64")).toHaveLength(32);
  });
});

describe("createNonce", () => {
  it("is long enough for the server's minimum and does not repeat", () => {
    const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));

    expect(nonces.size).toBe(50);
    for (const nonce of nonces) expect(nonce.length).toBeGreaterThanOrEqual(16);
  });
});

describe("sha256Hex", () => {
  it("matches a known digest for the empty body", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("signAdminRequest", () => {
  it("refuses to sign before the device is enrolled", async () => {
    await expect(signAdminRequest({ method: "GET", path: "/api/admin/loans" })).rejects.toThrow(
      /not enrolled/
    );
  });

  it("returns the four proof headers and no body for a GET", async () => {
    const { headers, body } = await signAdminRequest({
      method: "GET",
      path: "/api/admin/loans",
      deviceId: "device-1",
    });

    expect(Object.keys(headers).sort()).toEqual(
      [
        DEVICE_ID_HEADER,
        DEVICE_NONCE_HEADER,
        DEVICE_SIGNATURE_HEADER,
        DEVICE_TIMESTAMP_HEADER,
      ].sort()
    );
    expect(headers[DEVICE_ID_HEADER]).toBe("device-1");
    expect(body).toBeUndefined();
  });

  it("returns the exact body string it hashed", async () => {
    const payload = { decision: "approve", amount: "100.50" };
    const { body, headers } = await signAdminRequest({
      method: "POST",
      path: "/api/admin/loans/abc/approve",
      payload,
      deviceId: "device-1",
    });

    // Sending a re-serialisation would risk a different key order, so the
    // helper hands back the string it committed to.
    expect(body).toBe(JSON.stringify(payload));
    expect(headers["content-type"]).toBe("application/json");
  });

  it("never reuses a nonce across requests", async () => {
    const first = await signAdminRequest({
      method: "GET",
      path: "/api/admin/loans",
      deviceId: "device-1",
    });
    const second = await signAdminRequest({
      method: "GET",
      path: "/api/admin/loans",
      deviceId: "device-1",
    });

    expect(second.headers[DEVICE_NONCE_HEADER]).not.toBe(first.headers[DEVICE_NONCE_HEADER]);
    expect(second.headers[DEVICE_SIGNATURE_HEADER]).not.toBe(
      first.headers[DEVICE_SIGNATURE_HEADER]
    );
  });

  it("produces a signature the server's verifier accepts", async () => {
    const keyPair = await getOrCreateDeviceKeyPair();
    const publicKey = await importExportedPublicKey(keyPair);
    const payload = { decision: "approve" };

    const { headers, body } = await signAdminRequest({
      method: "POST",
      path: "/api/admin/loans/abc/approve",
      payload,
      deviceId: "device-1",
    });

    const message = new TextEncoder().encode(
      canonicalProofString({
        deviceId: headers[DEVICE_ID_HEADER],
        timestamp: Number(headers[DEVICE_TIMESTAMP_HEADER]),
        nonce: headers[DEVICE_NONCE_HEADER],
        method: "POST",
        path: "/api/admin/loans/abc/approve",
        bodyHash: await sha256Hex(body as string),
      })
    );

    const verified = await webcrypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      Buffer.from(headers[DEVICE_SIGNATURE_HEADER], "base64"),
      message
    );

    expect(verified).toBe(true);
  });

  it("produces a signature that does not verify against a different request", async () => {
    const keyPair = await getOrCreateDeviceKeyPair();
    const publicKey = await importExportedPublicKey(keyPair);

    const { headers } = await signAdminRequest({
      method: "GET",
      path: "/api/admin/loans",
      deviceId: "device-1",
    });

    const tampered = new TextEncoder().encode(
      canonicalProofString({
        deviceId: headers[DEVICE_ID_HEADER],
        timestamp: Number(headers[DEVICE_TIMESTAMP_HEADER]),
        nonce: headers[DEVICE_NONCE_HEADER],
        method: "POST",
        path: "/api/admin/loans/abc/approve",
        bodyHash: await sha256Hex(""),
      })
    );

    expect(
      await webcrypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        Buffer.from(headers[DEVICE_SIGNATURE_HEADER], "base64"),
        tampered
      )
    ).toBe(false);
  });
});

describe("enrollThisDevice", () => {
  it("posts the public key and remembers the device id", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        deviceId: "device-7",
        fingerprint: "f".repeat(64),
        label: "Laptop",
        mode: "enforce",
      }),
    });

    const result = await enrollThisDevice("Laptop", fetchMock as unknown as typeof fetch);

    expect(result.deviceId).toBe("device-7");
    expect(await getStoredDeviceId()).toBe("device-7");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/devices/enroll");
    // The cookie has to ride along: enrolment rebinds the current session.
    expect(init.credentials).toBe("include");
    const sent = JSON.parse(init.body);
    expect(Buffer.from(sent.publicKey, "base64")).toHaveLength(32);
    expect(sent.label).toBe("Laptop");
  });

  it("surfaces a server rejection and does not store a device id", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_public_key",
    });

    await expect(
      enrollThisDevice("Laptop", fetchMock as unknown as typeof fetch)
    ).rejects.toThrow(/400/);
    expect(await getStoredDeviceId()).toBeNull();
  });
});
