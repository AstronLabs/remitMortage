// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Trusted devices skipping step-up verification (issue #1105).
 */

import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import { Keypair } from "@stellar/stellar-sdk";
import { verificationRouter } from "../routes/verification";
import { recordLoginLocation, _clearLocationStores } from "../services/locationAnomalyService";
import { _setEntry } from "../services/challengeStore";
import { signSessionToken } from "../services/jwtKeyRing.js";
import { authMiddleware } from "../middleware/auth.js";
import { sessionsRouter } from "../routes/sessions.js";
import { adminTrustedDevicePolicyRouter } from "../routes/adminTrustedDevicePolicy.js";
import {
  TRUSTED_DEVICE_COOKIE,
  clearTrustedDevices,
  getTrustPeriodDays,
  isTrustedDevice,
  listTrustedDevices,
  revokeTrustedDevice,
  setTrustPeriodDays,
  trustDevice,
} from "../services/trustedDevices";

jest.mock("../config.js", () => {
  const actual = jest.requireActual("../config.js");
  return { ...actual, loadConfig: () => ({ ...actual.loadConfig(), adminApiKey: "test-admin-key" }) };
});

// Login location history is persisted via prisma.loginLocationHistory, so
// the db module mock needs a working (if fake) implementation of it rather
// than the bare jest.fn() stubs the other mocked exports use — tests below
// record a login then immediately re-query it to evaluate the next one.
// Each test uses its own distinct wallet address (existing convention), so
// a single array shared across the whole file never leaks state between
// tests — no explicit clearing is needed.
jest.mock("../services/db.js", () => {
  type FakeRow = {
    walletAddress: string;
    country: string;
    latitude: number;
    longitude: number;
    loginAt: Date;
  };
  const rows: FakeRow[] = [];

  return {
    upsertApplicant: jest.fn().mockResolvedValue({ id: "applicant-1" }),
    createVerificationResult: jest.fn().mockResolvedValue({ id: "verification-1" }),
    getNotificationPreference: jest.fn().mockResolvedValue(null),
    prisma: {
      loginLocationHistory: {
        create: jest.fn(async ({ data }: { data: FakeRow }) => {
          const row = { ...data };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(
          async ({
            where,
            orderBy,
            take,
          }: {
            where: { walletAddress: string };
            orderBy?: { loginAt: "asc" | "desc" };
            take?: number;
          }) => {
            const matching = rows
              .filter((r) => r.walletAddress === where.walletAddress)
              .sort((a, b) =>
                orderBy?.loginAt === "asc"
                  ? a.loginAt.getTime() - b.loginAt.getTime()
                  : b.loginAt.getTime() - a.loginAt.getTime()
              );
            return take ? matching.slice(0, take) : matching;
          }
        ),
      },
    },
  };
});

jest.mock("../middleware/rateLimit.js", () => ({
  verificationChallengeRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
  verificationOwnershipRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction
  ) => next(),
}));

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: jest.fn((_title: string, body: string) => body),
}));

jest.mock("../services/audit.js", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

function signStellarChallenge(keypair: Keypair, challenge: string): string {
  return Buffer.from(keypair.sign(Buffer.from(challenge, "utf8"))).toString("hex");
}

function buildVerificationApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/verification", verificationRouter);
  return app;
}

/** Attempts an anomalous (NY -> Tokyo within a minute) login, optionally presenting a trusted-device cookie. */
async function anomalousLogin(app: express.Express, keypair: Keypair, deviceToken?: string) {
  const walletAddress = keypair.publicKey();
  const challenge = `RemitMortgage-trusted-${Math.random()}`;
  _setEntry(walletAddress, { challenge, expiresAt: Date.now() + 10000, used: false });

  const req = request(app).post("/api/verification/verify-ownership").set("X-Forwarded-For", "3.3.3.3");
  if (deviceToken) req.set("Cookie", `${TRUSTED_DEVICE_COOKIE}=${deviceToken}`);
  return req.send({
    walletAddress,
    network: "stellar",
    challenge,
    signature: signStellarChallenge(keypair, challenge),
  });
}

function trustedDeviceTokenFrom(res: request.Response): string | undefined {
  const cookies = ([] as string[]).concat(res.headers["set-cookie"] ?? []);
  const match = cookies.find((c) => c.startsWith(`${TRUSTED_DEVICE_COOKIE}=`));
  return match?.split(";")[0].slice(TRUSTED_DEVICE_COOKIE.length + 1);
}

beforeEach(() => {
  _clearLocationStores();
  clearTrustedDevices();
  delete process.env.TRUSTED_DEVICE_TTL_DAYS;
});

describe("trustedDevices service", () => {
  it("trusts a device only for the wallet that trusted it", () => {
    const { token } = trustDevice("GWALLET_A", "Mozilla/5.0 (Macintosh) Chrome/126.0");
    expect(isTrustedDevice("GWALLET_A", token)).toBe(true);
    expect(isTrustedDevice("GWALLET_B", token)).toBe(false);
    expect(isTrustedDevice("GWALLET_A", "not-a-real-token")).toBe(false);
    expect(isTrustedDevice("GWALLET_A", undefined)).toBe(false);
  });

  it("stops trusting a device once its trust period expires", () => {
    setTrustPeriodDays(7);
    const trustedAt = new Date("2026-11-01T00:00:00.000Z");
    const { token, device } = trustDevice("GWALLET_A", undefined, trustedAt);

    expect(device.expiresAt).toBe("2026-11-08T00:00:00.000Z");
    expect(isTrustedDevice("GWALLET_A", token, new Date(trustedAt.getTime() + 7 * DAY_MS - 1))).toBe(true);
    expect(isTrustedDevice("GWALLET_A", token, new Date(trustedAt.getTime() + 7 * DAY_MS))).toBe(false);
    expect(listTrustedDevices("GWALLET_A", new Date(trustedAt.getTime() + 8 * DAY_MS))).toEqual([]);
  });

  it("revocation removes trust immediately and is limited to the owner", () => {
    const { token, device } = trustDevice("GWALLET_A");
    expect(revokeTrustedDevice("GWALLET_B", device.deviceId)).toEqual({ ok: false, reason: "forbidden" });
    expect(isTrustedDevice("GWALLET_A", token)).toBe(true);

    expect(revokeTrustedDevice("GWALLET_A", device.deviceId).ok).toBe(true);
    expect(isTrustedDevice("GWALLET_A", token)).toBe(false);
    expect(revokeTrustedDevice("GWALLET_A", device.deviceId)).toEqual({ ok: false, reason: "not_found" });
  });

  it("uses the env default, then an admin override, and rejects out-of-range periods", () => {
    expect(getTrustPeriodDays()).toBe(30);
    process.env.TRUSTED_DEVICE_TTL_DAYS = "14";
    expect(getTrustPeriodDays()).toBe(14);
    setTrustPeriodDays(3);
    expect(getTrustPeriodDays()).toBe(3);
    expect(() => setTrustPeriodDays(0)).toThrow(RangeError);
    expect(() => setTrustPeriodDays(366)).toThrow(RangeError);
    expect(() => setTrustPeriodDays(1.5)).toThrow(RangeError);
  });

  it("never exposes the token hash when listing devices", () => {
    trustDevice("GWALLET_A");
    const [listed] = listTrustedDevices("GWALLET_A");
    expect(listed).not.toHaveProperty("tokenHash");
  });
});

describe("step-up skip for trusted devices", () => {
  it("a device trusted after step-up skips step-up on its next anomalous login", async () => {
    const app = buildVerificationApp();
    const keypair = Keypair.random();
    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());

    const first = await anomalousLogin(app, keypair);
    expect(first.status).toBe(202);
    expect(first.body.stepUpRequired).toBe(true);

    const stepUp = await request(app)
      .post("/api/verification/step-up")
      .set("X-Forwarded-For", "3.3.3.3")
      .send({ walletAddress: keypair.publicKey(), network: "stellar", code: first.body.stepUpCode, trustDevice: true });
    expect(stepUp.status).toBe(200);
    expect(stepUp.body.trustedDeviceId).toBeDefined();
    const deviceToken = trustedDeviceTokenFrom(stepUp);
    expect(deviceToken).toBeDefined();

    // Back in NY, then Tokyo again a minute later: still anomalous, but trusted.
    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());
    const second = await anomalousLogin(app, keypair, deviceToken);
    expect(second.status).toBe(200);
    expect(second.body.stepUpRequired).toBe(false);
    expect(second.body.trustedDevice).toBe(true);
  });

  it("does not trust the device unless the user asks for it", async () => {
    const app = buildVerificationApp();
    const keypair = Keypair.random();
    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());
    const first = await anomalousLogin(app, keypair);

    const stepUp = await request(app)
      .post("/api/verification/step-up")
      .send({ walletAddress: keypair.publicKey(), network: "stellar", code: first.body.stepUpCode });
    expect(stepUp.status).toBe(200);
    expect(stepUp.body.trustedDeviceId).toBeUndefined();
    expect(trustedDeviceTokenFrom(stepUp)).toBeUndefined();
  });

  it("requires step-up again once the trust period has expired", async () => {
    const app = buildVerificationApp();
    const keypair = Keypair.random();
    setTrustPeriodDays(1);
    const { token } = trustDevice(keypair.publicKey(), undefined, new Date(Date.now() - 2 * DAY_MS));
    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());

    const res = await anomalousLogin(app, keypair, token);
    expect(res.status).toBe(202);
    expect(res.body.stepUpRequired).toBe(true);
  });

  it("revoking a trusted device takes effect on its very next login attempt", async () => {
    const app = buildVerificationApp();
    const keypair = Keypair.random();
    const { token, device } = trustDevice(keypair.publicKey());

    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());
    const trusted = await anomalousLogin(app, keypair, token);
    expect(trusted.status).toBe(200);

    revokeTrustedDevice(keypair.publicKey(), device.deviceId);

    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());
    const afterRevoke = await anomalousLogin(app, keypair, token);
    expect(afterRevoke.status).toBe(202);
    expect(afterRevoke.body.stepUpRequired).toBe(true);
  });

  it("a trusted-device cookie belonging to another wallet does not skip step-up", async () => {
    const app = buildVerificationApp();
    const keypair = Keypair.random();
    const { token } = trustDevice(Keypair.random().publicKey());
    await recordLoginLocation(keypair.publicKey(), "1.1.1.1", Date.now());

    const res = await anomalousLogin(app, keypair, token);
    expect(res.status).toBe(202);
  });
});

describe("trusted devices on the session management page", () => {
  function buildSessionsApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/sessions", authMiddleware, sessionsRouter);
    return app;
  }

  it("lists the caller's trusted devices and revokes one immediately", async () => {
    const app = buildSessionsApp();
    const alice = "GALICE_TRUSTED_WALLET";
    const { token: aliceToken, device } = trustDevice(alice, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1");
    trustDevice("GBOB_TRUSTED_WALLET");
    const auth = `Bearer ${signSessionToken({ walletAddress: alice, network: "testnet" })}`;

    const listed = await request(app).get("/api/sessions/trusted-devices").set("Authorization", auth);
    expect(listed.status).toBe(200);
    expect(listed.body.trustedDevices).toHaveLength(1);
    expect(listed.body.trustedDevices[0]).toMatchObject({ deviceId: device.deviceId, deviceSummary: "Safari on iOS" });

    const revoked = await request(app)
      .delete(`/api/sessions/trusted-devices/${device.deviceId}`)
      .set("Authorization", auth);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: true, deviceId: device.deviceId });
    expect(isTrustedDevice(alice, aliceToken)).toBe(false);

    const after = await request(app).get("/api/sessions/trusted-devices").set("Authorization", auth);
    expect(after.body.trustedDevices).toEqual([]);
  });

  it("refuses to revoke another user's trusted device and 404s an unknown one", async () => {
    const app = buildSessionsApp();
    const { device } = trustDevice("GBOB_TRUSTED_WALLET");
    const auth = `Bearer ${signSessionToken({ walletAddress: "GALICE_TRUSTED_WALLET", network: "testnet" })}`;

    const forbidden = await request(app).delete(`/api/sessions/trusted-devices/${device.deviceId}`).set("Authorization", auth);
    expect(forbidden.status).toBe(403);

    const missing = await request(app).delete("/api/sessions/trusted-devices/does-not-exist").set("Authorization", auth);
    expect(missing.status).toBe(404);
  });
});

describe("admin trusted-device policy", () => {
  function buildAdminApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/admin", adminTrustedDevicePolicyRouter);
    return app;
  }

  it("reads and updates the trust period used for newly trusted devices", async () => {
    const app = buildAdminApp();
    const auth = "Bearer test-admin-key";

    const before = await request(app).get("/api/admin/security/trusted-device-policy").set("Authorization", auth);
    expect(before.status).toBe(200);
    expect(before.body.trustPeriodDays).toBe(30);

    const updated = await request(app)
      .put("/api/admin/security/trusted-device-policy")
      .set("Authorization", auth)
      .send({ trustPeriodDays: 10 });
    expect(updated.status).toBe(200);
    expect(updated.body.trustPeriodDays).toBe(10);

    const now = new Date("2026-11-21T00:00:00.000Z");
    expect(trustDevice("GWALLET_A", undefined, now).device.expiresAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("rejects an invalid period and non-admin callers", async () => {
    const app = buildAdminApp();
    const bad = await request(app)
      .put("/api/admin/security/trusted-device-policy")
      .set("Authorization", "Bearer test-admin-key")
      .send({ trustPeriodDays: 0 });
    expect(bad.status).toBe(400);

    const anon = await request(app).put("/api/admin/security/trusted-device-policy").send({ trustPeriodDays: 5 });
    expect(anon.status).toBe(401);
  });
});
