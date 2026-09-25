// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  rotateSecret,
  verifySubscriptionSignature,
  pruneExpiredPreviousSecrets,
  rotateDueSecrets,
  signPayload,
  ROTATION_GRACE_PERIOD_DAYS,
  ROTATION_INTERVAL_DAYS,
} from "../services/webhook.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { prisma } from "../services/db.js";

const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

jest.mock("../services/db.js", () => ({
  prisma: {
    webhookSubscription: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

beforeEach(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY;
  jest.clearAllMocks();
});

afterEach(() => {
  delete process.env.ENCRYPTION_KEY;
});

describe("rotateSecret", () => {
  it("demotes the current secret to previousSecret and issues a fresh primary secret", async () => {
    const oldEncrypted = encrypt("old-plaintext-secret");
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue({
      secret: oldEncrypted,
    });
    (prisma.webhookSubscription.update as jest.Mock).mockResolvedValue({});

    const { plaintextSecret } = await rotateSecret("sub-1");

    expect(plaintextSecret).toEqual(expect.any(String));
    expect(plaintextSecret).not.toBe("old-plaintext-secret");

    expect(prisma.webhookSubscription.update).toHaveBeenCalledTimes(1);
    const call = (prisma.webhookSubscription.update as jest.Mock).mock.calls[0][0];
    expect(call.where).toEqual({ id: "sub-1" });
    expect(decrypt(call.data.previousSecret)).toBe("old-plaintext-secret");
    expect(decrypt(call.data.secret)).toBe(plaintextSecret);
    expect(call.data.secretRotatedAt).toBeInstanceOf(Date);

    const expiresAt = call.data.previousSecretExpiresAt as Date;
    const expectedMs = ROTATION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - call.data.secretRotatedAt.getTime()).toBeCloseTo(expectedMs, -2);
  });

  it("throws when the subscription does not exist", async () => {
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(rotateSecret("missing")).rejects.toThrow("not found");
  });
});

describe("verifySubscriptionSignature", () => {
  const timestamp = String(Date.now());
  const rawBody = JSON.stringify({ hello: "world" });

  it("validates against the current primary secret", async () => {
    const primary = "current-secret";
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue({
      secret: encrypt(primary),
      previousSecret: null,
      previousSecretExpiresAt: null,
    });

    const signature = signPayload(primary, timestamp, rawBody);
    await expect(
      verifySubscriptionSignature("sub-1", timestamp, rawBody, signature)
    ).resolves.toBe(true);
  });

  it("validates against the previous secret while inside the grace period", async () => {
    const primary = "new-secret";
    const previous = "old-secret";
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue({
      secret: encrypt(primary),
      previousSecret: encrypt(previous),
      previousSecretExpiresAt: new Date(Date.now() + 60_000),
    });

    const signature = signPayload(previous, timestamp, rawBody);
    await expect(
      verifySubscriptionSignature("sub-1", timestamp, rawBody, signature)
    ).resolves.toBe(true);
  });

  it("rejects the previous secret once its grace period has expired", async () => {
    const primary = "new-secret";
    const previous = "old-secret";
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue({
      secret: encrypt(primary),
      previousSecret: encrypt(previous),
      previousSecretExpiresAt: new Date(Date.now() - 1_000),
    });

    const signature = signPayload(previous, timestamp, rawBody);
    await expect(
      verifySubscriptionSignature("sub-1", timestamp, rawBody, signature)
    ).resolves.toBe(false);
  });

  it("returns false for an unknown subscription", async () => {
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(
      verifySubscriptionSignature("missing", timestamp, rawBody, "sha256=deadbeef")
    ).resolves.toBe(false);
  });
});

describe("pruneExpiredPreviousSecrets", () => {
  it("clears previousSecret/previousSecretExpiresAt only for expired grace windows", async () => {
    (prisma.webhookSubscription.updateMany as jest.Mock).mockResolvedValue({ count: 3 });

    const pruned = await pruneExpiredPreviousSecrets();

    expect(pruned).toBe(3);
    const call = (prisma.webhookSubscription.updateMany as jest.Mock).mock.calls[0][0];
    expect(call.where.previousSecret).toEqual({ not: null });
    expect(call.where.previousSecretExpiresAt).toHaveProperty("lte");
    expect(call.data).toEqual({ previousSecret: null, previousSecretExpiresAt: null });
  });
});

describe("rotateDueSecrets", () => {
  it("rotates every non-revoked subscription older than ROTATION_INTERVAL_DAYS and returns the new secrets", async () => {
    (prisma.webhookSubscription.findMany as jest.Mock).mockResolvedValue([
      { id: "sub-1" },
      { id: "sub-2" },
    ]);
    (prisma.webhookSubscription.findUnique as jest.Mock).mockResolvedValue({
      secret: encrypt("whatever-was-active"),
    });
    (prisma.webhookSubscription.update as jest.Mock).mockResolvedValue({});

    const { rotatedIds, secrets } = await rotateDueSecrets();

    expect(rotatedIds).toEqual(["sub-1", "sub-2"]);
    expect(Object.keys(secrets)).toEqual(["sub-1", "sub-2"]);
    expect(secrets["sub-1"]).toEqual(expect.any(String));

    const findManyArgs = (prisma.webhookSubscription.findMany as jest.Mock).mock.calls[0][0];
    expect(findManyArgs.where.status).toEqual({ not: "revoked" });
    const cutoff = findManyArgs.where.secretRotatedAt.lte as Date;
    const expectedCutoffMs = ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    expect(Date.now() - cutoff.getTime()).toBeCloseTo(expectedCutoffMs, -2);
  });
});
