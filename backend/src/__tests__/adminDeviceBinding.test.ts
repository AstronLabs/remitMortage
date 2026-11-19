// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Device binding for admin sessions (issue #886).
 *
 * The scenario that matters is the last describe block: a real admin enrols a
 * device, works normally, and then the *same session cookie* is replayed from
 * a second machine holding its own key. The cookie is byte-identical; only the
 * device differs. It must be rejected.
 */

import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import nacl from "tweetnacl";

import { authMiddleware, requireAdmin, type AuthenticatedRequest } from "../middleware/auth";
import {
  requireBoundDevice,
  _resetBindingNotificationThrottle,
} from "../middleware/adminDeviceBinding";
import { adminDevicesRouter } from "../routes/adminDevices";
import { signSessionToken } from "../services/jwtKeyRing";
import {
  DEVICE_ID_HEADER,
  DEVICE_NONCE_HEADER,
  DEVICE_SIGNATURE_HEADER,
  DEVICE_TIMESTAMP_HEADER,
  PROOF_SKEW_MS,
  _resetAdminDeviceStore,
  canonicalProofString,
  deviceBindingMode,
  enrollAdminDevice,
  fingerprintPublicKey,
  hashRequestBody,
  listAdminDevices,
  revokeAdminDevice,
  verifyDeviceProof,
} from "../services/adminDeviceBinding";

jest.mock("../services/audit", () => ({
  logAudit: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/email", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: (title: string, body: string) => `${title}${body}`,
}));

const { logAudit } = require("../services/audit") as { logAudit: jest.Mock };
const { sendEmail } = require("../services/email") as { sendEmail: jest.Mock };

const ADMIN_ADDRESS = "GADMIN00000000000000000000000000000000000000000000000000";
const OTHER_ADMIN = "GOTHER00000000000000000000000000000000000000000000000000";

/** A device: an Ed25519 keypair plus the helpers a real client would have. */
function makeDevice(label = "Test device") {
  const keypair = nacl.sign.keyPair();
  const publicKey = Buffer.from(keypair.publicKey).toString("base64");

  return {
    label,
    publicKey,
    fingerprint: fingerprintPublicKey(publicKey) as string,
    /** Signs the canonical proof string exactly as the browser helper does. */
    sign(input: {
      deviceId: string;
      timestamp: number;
      nonce: string;
      method: string;
      path: string;
      bodyHash: string;
    }): string {
      const message = new TextEncoder().encode(canonicalProofString(input));
      return Buffer.from(nacl.sign.detached(message, keypair.secretKey)).toString("base64");
    },
  };
}

let nonceCounter = 0;
function freshNonce(): string {
  nonceCounter += 1;
  return `nonce-${nonceCounter}-${"x".repeat(12)}`;
}

/** Proof headers for one request, as a bound client would attach them. */
function proofHeaders(
  device: ReturnType<typeof makeDevice>,
  deviceId: string,
  method: string,
  path: string,
  body?: unknown,
  overrides: { timestamp?: number; nonce?: string; signature?: string } = {}
): Record<string, string> {
  const timestamp = overrides.timestamp ?? Date.now();
  const nonce = overrides.nonce ?? freshNonce();
  const bodyHash =
    body === undefined ? hashRequestBody("") : hashRequestBody(JSON.stringify(body));

  return {
    [DEVICE_ID_HEADER]: deviceId,
    [DEVICE_TIMESTAMP_HEADER]: String(timestamp),
    [DEVICE_NONCE_HEADER]: nonce,
    [DEVICE_SIGNATURE_HEADER]:
      overrides.signature ??
      device.sign({ deviceId, timestamp, nonce, method, path, bodyHash }),
  };
}

function sessionCookie(claims: Record<string, unknown>): string {
  return `token=${signSessionToken({ walletAddress: ADMIN_ADDRESS, ...claims }, { expiresIn: "1h" })}`;
}

/** A stand-in for the real admin router: two routes, both admin-gated. */
function stubAdminRouter() {
  const router = express.Router();
  router.get("/loans", requireAdmin, (_req: AuthenticatedRequest, res) =>
    res.json({ loans: [] })
  );
  router.post("/loans/:id/approve", requireAdmin, (req: AuthenticatedRequest, res) =>
    res.json({ approved: req.params.id })
  );
  return router;
}

/**
 * An app wired exactly like `index.ts`: `authMiddleware` decodes the session
 * (and its `dbk` claim), then `requireBoundDevice()` guards every admin
 * router.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/admin", authMiddleware, requireBoundDevice(), adminDevicesRouter);
  app.use("/api/admin", authMiddleware, requireBoundDevice(), stubAdminRouter());
  return app;
}

/**
 * The other wiring shape in `index.ts`: a router mounted bare, with
 * `requireAdmin` per route resolving the identity and `requireBoundDevice()`
 * after it — how `impersonationRouter` is guarded. This is the only shape in
 * which the static admin API key can reach an admin handler.
 */
function buildBareApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const router = express.Router();
  router.get("/loans", requireAdmin, requireBoundDevice(), (_req: AuthenticatedRequest, res) =>
    res.json({ loans: [] })
  );
  app.use("/api/admin", router);
  return app;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  _resetAdminDeviceStore();
  _resetBindingNotificationThrottle();
  jest.clearAllMocks();
  process.env.ADMIN_WALLET_ADDRESS = ADMIN_ADDRESS;
  process.env.ADMIN_DEVICE_BINDING = "enforce";
  process.env.JWT_SECRET = "test_jwt_secret_for_device_binding";
});

afterAll(() => {
  process.env = originalEnv;
});

// ── Mode resolution ──────────────────────────────────────────────────────

describe("deviceBindingMode", () => {
  it("honours an explicit mode", () => {
    for (const mode of ["off", "monitor", "enforce"] as const) {
      process.env.ADMIN_DEVICE_BINDING = mode;
      expect(deviceBindingMode()).toBe(mode);
    }
  });

  it("enforces by default in production and monitors elsewhere", () => {
    delete process.env.ADMIN_DEVICE_BINDING;
    const originalNodeEnv = process.env.NODE_ENV;

    process.env.NODE_ENV = "production";
    expect(deviceBindingMode()).toBe("enforce");

    process.env.NODE_ENV = "development";
    expect(deviceBindingMode()).toBe("monitor");

    process.env.NODE_ENV = originalNodeEnv;
  });

  it("falls back rather than trusting an unrecognised value", () => {
    process.env.ADMIN_DEVICE_BINDING = "yes-please";
    expect(["monitor", "enforce"]).toContain(deviceBindingMode());
  });
});

// ── Enrolment ────────────────────────────────────────────────────────────

describe("enrollAdminDevice", () => {
  it("rejects anything that is not a 32-byte Ed25519 key", () => {
    for (const publicKey of ["", "not-base64!!", Buffer.alloc(16).toString("base64")]) {
      expect(() => enrollAdminDevice({ adminAddress: ADMIN_ADDRESS, publicKey })).toThrow(
        /Ed25519/
      );
    }
  });

  it("is idempotent for the same key, so a reload does not duplicate a device", () => {
    const device = makeDevice();

    const first = enrollAdminDevice({
      adminAddress: ADMIN_ADDRESS,
      publicKey: device.publicKey,
      label: "Laptop",
    });
    const second = enrollAdminDevice({
      adminAddress: ADMIN_ADDRESS,
      publicKey: device.publicKey,
      label: "Laptop (renamed)",
    });

    expect(second.deviceId).toBe(first.deviceId);
    expect(second.label).toBe("Laptop (renamed)");
    expect(listAdminDevices(ADMIN_ADDRESS)).toHaveLength(1);
  });

  it("keeps one admin's devices out of another's list", () => {
    enrollAdminDevice({ adminAddress: ADMIN_ADDRESS, publicKey: makeDevice().publicKey });
    enrollAdminDevice({ adminAddress: OTHER_ADMIN, publicKey: makeDevice().publicKey });

    expect(listAdminDevices(ADMIN_ADDRESS)).toHaveLength(1);
    expect(listAdminDevices(OTHER_ADMIN)).toHaveLength(1);
  });

  it("never exposes the public key in a listing", () => {
    enrollAdminDevice({ adminAddress: ADMIN_ADDRESS, publicKey: makeDevice().publicKey });
    expect(listAdminDevices(ADMIN_ADDRESS)[0]).not.toHaveProperty("publicKey");
  });
});

// ── Proof verification, unit level ───────────────────────────────────────

describe("verifyDeviceProof", () => {
  function enrol(device = makeDevice(), adminAddress = ADMIN_ADDRESS) {
    const record = enrollAdminDevice({ adminAddress, publicKey: device.publicKey });
    return { device, record };
  }

  function validProof(
    device: ReturnType<typeof makeDevice>,
    deviceId: string,
    overrides: Partial<Parameters<typeof verifyDeviceProof>[0]> = {}
  ) {
    const timestamp = Date.now();
    const nonce = freshNonce();
    const bodyHash = hashRequestBody("");
    return verifyDeviceProof({
      adminAddress: ADMIN_ADDRESS,
      sessionFingerprint: device.fingerprint,
      deviceId,
      timestamp,
      nonce,
      signature: device.sign({
        deviceId,
        timestamp,
        nonce,
        method: "GET",
        path: "/api/admin/loans",
        bodyHash,
      }),
      method: "GET",
      path: "/api/admin/loans",
      bodyHash,
      ...overrides,
    });
  }

  it("accepts a well-formed proof from the bound device", () => {
    const { device, record } = enrol();
    const result = validProof(device, record.deviceId);

    expect(result).toEqual({ ok: true, device: expect.objectContaining({ deviceId: record.deviceId }) });
  });

  it("records lastSeenAt on a successful proof", () => {
    const { device, record } = enrol();
    expect(record.lastSeenAt).toBeNull();

    validProof(device, record.deviceId);

    expect(listAdminDevices(ADMIN_ADDRESS)[0].lastSeenAt).toBeInstanceOf(Date);
  });

  it.each([
    ["deviceId", { deviceId: undefined }],
    ["signature", { signature: undefined }],
    ["nonce", { nonce: undefined }],
    ["timestamp", { timestamp: undefined }],
  ])("reports missing_proof when the %s header is absent", (_name, overrides) => {
    const { device, record } = enrol();
    expect(validProof(device, record.deviceId, overrides as never)).toMatchObject({
      ok: false,
      reason: "missing_proof",
    });
  });

  it("rejects a nonce too short to be unpredictable", () => {
    const { device, record } = enrol();
    expect(validProof(device, record.deviceId, { nonce: "short" })).toMatchObject({
      reason: "malformed_proof",
    });
  });

  it("rejects an unknown device id", () => {
    const { device } = enrol();
    expect(validProof(device, "00000000-0000-0000-0000-000000000000")).toMatchObject({
      reason: "unknown_device",
    });
  });

  it("rejects a revoked device", () => {
    const { device, record } = enrol();
    revokeAdminDevice(record.deviceId, ADMIN_ADDRESS, "lost laptop");

    expect(validProof(device, record.deviceId)).toMatchObject({ reason: "device_revoked" });
  });

  it("rejects a device enrolled under a different admin", () => {
    const { device, record } = enrol(makeDevice(), OTHER_ADMIN);

    expect(
      validProof(device, record.deviceId, { adminAddress: ADMIN_ADDRESS })
    ).toMatchObject({ reason: "device_owner_mismatch" });
  });

  it("rejects a proof whose device is not the one the session is bound to", () => {
    const { device, record } = enrol();
    const otherDevice = makeDevice();
    enrollAdminDevice({ adminAddress: ADMIN_ADDRESS, publicKey: otherDevice.publicKey });

    expect(
      validProof(device, record.deviceId, { sessionFingerprint: otherDevice.fingerprint })
    ).toMatchObject({ reason: "device_mismatch" });
  });

  it("rejects a proof older than the skew window", () => {
    const { device, record } = enrol();
    const timestamp = Date.now() - PROOF_SKEW_MS - 1_000;
    const nonce = freshNonce();
    const bodyHash = hashRequestBody("");

    const result = verifyDeviceProof({
      adminAddress: ADMIN_ADDRESS,
      sessionFingerprint: device.fingerprint,
      deviceId: record.deviceId,
      timestamp,
      nonce,
      signature: device.sign({
        deviceId: record.deviceId,
        timestamp,
        nonce,
        method: "GET",
        path: "/api/admin/loans",
        bodyHash,
      }),
      method: "GET",
      path: "/api/admin/loans",
      bodyHash,
    });

    expect(result).toMatchObject({ reason: "stale_proof" });
  });

  it("rejects a captured proof replayed verbatim", () => {
    const { device, record } = enrol();
    const timestamp = Date.now();
    const nonce = freshNonce();
    const bodyHash = hashRequestBody("");
    const proof = {
      adminAddress: ADMIN_ADDRESS,
      sessionFingerprint: device.fingerprint,
      deviceId: record.deviceId,
      timestamp,
      nonce,
      signature: device.sign({
        deviceId: record.deviceId,
        timestamp,
        nonce,
        method: "GET",
        path: "/api/admin/loans",
        bodyHash,
      }),
      method: "GET",
      path: "/api/admin/loans",
      bodyHash,
    };

    expect(verifyDeviceProof(proof)).toMatchObject({ ok: true });
    expect(verifyDeviceProof(proof)).toMatchObject({ reason: "replayed_proof" });
  });

  it("does not burn a client's nonce on a forged signature", () => {
    const { device, record } = enrol();
    const timestamp = Date.now();
    const nonce = freshNonce();
    const bodyHash = hashRequestBody("");
    const base = {
      adminAddress: ADMIN_ADDRESS,
      sessionFingerprint: device.fingerprint,
      deviceId: record.deviceId,
      timestamp,
      nonce,
      method: "GET",
      path: "/api/admin/loans",
      bodyHash,
    };

    const forged = Buffer.from(nacl.sign.detached(
      new TextEncoder().encode("something else"),
      nacl.sign.keyPair().secretKey
    )).toString("base64");

    expect(verifyDeviceProof({ ...base, signature: forged })).toMatchObject({
      reason: "invalid_signature",
    });
    // The legitimate client can still use that nonce.
    expect(
      verifyDeviceProof({
        ...base,
        signature: device.sign({ ...base, deviceId: record.deviceId }),
      })
    ).toMatchObject({ ok: true });
  });

  it("rejects a signature lifted onto a different request", () => {
    const { device, record } = enrol();
    const timestamp = Date.now();
    const nonce = freshNonce();
    const bodyHash = hashRequestBody("");

    // Signed for a read; presented on a write.
    const signature = device.sign({
      deviceId: record.deviceId,
      timestamp,
      nonce,
      method: "GET",
      path: "/api/admin/loans",
      bodyHash,
    });

    expect(
      verifyDeviceProof({
        adminAddress: ADMIN_ADDRESS,
        sessionFingerprint: device.fingerprint,
        deviceId: record.deviceId,
        timestamp,
        nonce,
        signature,
        method: "POST",
        path: "/api/admin/loans/abc/approve",
        bodyHash,
      })
    ).toMatchObject({ reason: "invalid_signature" });
  });

  it("rejects a proof whose body hash does not match the body sent", () => {
    const { device, record } = enrol();
    const timestamp = Date.now();
    const nonce = freshNonce();

    const signature = device.sign({
      deviceId: record.deviceId,
      timestamp,
      nonce,
      method: "POST",
      path: "/api/admin/loans/abc/approve",
      bodyHash: hashRequestBody(JSON.stringify({ amount: "10" })),
    });

    expect(
      verifyDeviceProof({
        adminAddress: ADMIN_ADDRESS,
        sessionFingerprint: device.fingerprint,
        deviceId: record.deviceId,
        timestamp,
        nonce,
        signature,
        method: "POST",
        path: "/api/admin/loans/abc/approve",
        bodyHash: hashRequestBody(JSON.stringify({ amount: "1000000" })),
      })
    ).toMatchObject({ reason: "invalid_signature" });
  });
});

// ── HTTP: enrolment endpoint ─────────────────────────────────────────────

describe("POST /api/admin/devices/enroll", () => {
  it("binds the session and returns the fingerprint", async () => {
    const device = makeDevice("MacBook — Chrome");

    const res = await request(buildApp())
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: device.publicKey, label: device.label });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fingerprint: device.fingerprint,
      label: "MacBook — Chrome",
      bound: true,
    });
    // The response must re-issue the cookie: that is what binds the session.
    expect(res.headers["set-cookie"].join(";")).toMatch(/token=/);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.device_binding.enrolled" })
    );
  });

  it("is reachable on an unbound session, unlike every other admin route", async () => {
    const app = buildApp();
    const unbound = sessionCookie({});

    const blocked = await request(app).get("/api/admin/loans").set("Cookie", unbound);
    expect(blocked.status).toBe(401);
    expect(blocked.body.error).toBe("device_binding_required");

    const allowed = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", unbound)
      .send({ publicKey: makeDevice().publicKey });
    expect(allowed.status).toBe(201);
  });

  it("rejects a malformed public key with 400", async () => {
    const res = await request(buildApp())
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: "nope" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_public_key");
  });

  it("requires an admin session", async () => {
    const res = await request(buildApp())
      .post("/api/admin/devices/enroll")
      .send({ publicKey: makeDevice().publicKey });

    expect(res.status).toBe(401);
  });
});

// ── HTTP: the scenario the issue describes ───────────────────────────────

describe("replaying an admin session from another device", () => {
  /** Enrols `device` and returns the bound session cookie the server issued. */
  async function boundSession(app: express.Express, device: ReturnType<typeof makeDevice>) {
    const res = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: device.publicKey, label: device.label });

    expect(res.status).toBe(201);
    const setCookie: string[] = res.headers["set-cookie"];
    const cookie = setCookie.map((entry) => entry.split(";")[0]).join("; ");
    return { cookie, deviceId: res.body.deviceId as string };
  }

  it("rejects the copied cookie and leaves the legitimate device working", async () => {
    const app = buildApp();
    const laptop = makeDevice("Admin laptop");
    const { cookie, deviceId } = await boundSession(app, laptop);

    // 1. The real admin works normally.
    const legitimate = await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(proofHeaders(laptop, deviceId, "GET", "/api/admin/loans"));
    expect(legitimate.status).toBe(200);

    // 2. The attacker steals the cookie — byte-identical — and enrols their
    //    own device, then presents both. The cookie's `dbk` still names the
    //    laptop, so the mismatch is caught.
    const attackerDevice = makeDevice("Attacker VM");
    const attackerEnrol = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", cookie)
      .send({ publicKey: attackerDevice.publicKey });
    const attackerDeviceId = attackerEnrol.body.deviceId as string;

    const replayed = await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(proofHeaders(attackerDevice, attackerDeviceId, "GET", "/api/admin/loans"));

    expect(replayed.status).toBe(401);
    expect(replayed.body).toMatchObject({
      error: "device_binding_failed",
      reason: "device_mismatch",
      reauthRequired: true,
    });

    // 3. The rejection forces a fresh login: the session cookie is cleared.
    expect(String(replayed.headers["set-cookie"] ?? "")).toMatch(/token=;/);

    // 4. And the real admin is unaffected — no extra prompt, no re-enrolment.
    const stillWorking = await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(proofHeaders(laptop, deviceId, "GET", "/api/admin/loans"));
    expect(stillWorking.status).toBe(200);
  });

  it("rejects the cookie replayed with no device proof at all", async () => {
    const app = buildApp();
    const laptop = makeDevice();
    const { cookie } = await boundSession(app, laptop);

    const res = await request(app).get("/api/admin/loans").set("Cookie", cookie);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: "device_binding_failed", reason: "missing_proof" });
  });

  it("rejects the admin's own captured proof replayed a second time", async () => {
    const app = buildApp();
    const laptop = makeDevice();
    const { cookie, deviceId } = await boundSession(app, laptop);
    const headers = proofHeaders(laptop, deviceId, "GET", "/api/admin/loans");

    expect((await request(app).get("/api/admin/loans").set("Cookie", cookie).set(headers)).status).toBe(200);

    const replayed = await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(headers);

    expect(replayed.status).toBe(401);
    expect(replayed.body.reason).toBe("replayed_proof");
  });

  it("records the rejection in the audit trail and notifies the admin", async () => {
    process.env.ADMIN_ALERT_EMAIL = "security@example.com";
    const app = buildApp();
    const laptop = makeDevice();
    const { cookie } = await boundSession(app, laptop);
    const attacker = makeDevice();
    const attackerEnrol = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", cookie)
      .send({ publicKey: attacker.publicKey });

    jest.clearAllMocks();

    await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(proofHeaders(attacker, attackerEnrol.body.deviceId, "GET", "/api/admin/loans"));

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.device_binding.failed",
        metadata: expect.objectContaining({ reason: "device_mismatch", mode: "enforce" }),
      })
    );
    // Give the fire-and-forget notification a turn to run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(sendEmail).toHaveBeenCalledWith(
      "security@example.com",
      expect.stringContaining("unrecognised device"),
      expect.stringContaining("device_mismatch")
    );

    delete process.env.ADMIN_ALERT_EMAIL;
  });

  it("does not notify on clock skew, which is operational noise", async () => {
    process.env.ADMIN_ALERT_EMAIL = "security@example.com";
    const app = buildApp();
    const laptop = makeDevice();
    const { cookie, deviceId } = await boundSession(app, laptop);
    jest.clearAllMocks();

    await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(
        proofHeaders(laptop, deviceId, "GET", "/api/admin/loans", undefined, {
          timestamp: Date.now() - PROOF_SKEW_MS - 5_000,
        })
      );

    await new Promise((resolve) => setImmediate(resolve));
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: "stale_proof" }) })
    );
    expect(sendEmail).not.toHaveBeenCalled();

    delete process.env.ADMIN_ALERT_EMAIL;
  });
});

// ── HTTP: a legitimate device keeps working ──────────────────────────────

describe("a legitimate device", () => {
  it("serves repeated reads and writes without any extra prompt", async () => {
    const app = buildApp();
    const laptop = makeDevice();
    const enrol = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: laptop.publicKey });
    const cookie = (enrol.headers["set-cookie"] as string[])
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const deviceId = enrol.body.deviceId as string;

    for (let i = 0; i < 3; i += 1) {
      const read = await request(app)
        .get("/api/admin/loans")
        .set("Cookie", cookie)
        .set(proofHeaders(laptop, deviceId, "GET", "/api/admin/loans"));
      expect(read.status).toBe(200);
    }

    const body = { decision: "approve" };
    const write = await request(app)
      .post("/api/admin/loans/loan-1/approve")
      .set("Cookie", cookie)
      .set(proofHeaders(laptop, deviceId, "POST", "/api/admin/loans/loan-1/approve", body))
      .send(body);

    expect(write.status).toBe(200);
    expect(write.body).toEqual({ approved: "loan-1" });
  });

  it("sees itself flagged as current in the device list", async () => {
    const app = buildApp();
    const laptop = makeDevice("Laptop");
    const enrol = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: laptop.publicKey, label: "Laptop" });
    const cookie = (enrol.headers["set-cookie"] as string[])
      .map((entry) => entry.split(";")[0])
      .join("; ");

    const res = await request(app)
      .get("/api/admin/devices")
      .set("Cookie", cookie)
      .set(proofHeaders(laptop, enrol.body.deviceId, "GET", "/api/admin/devices"));

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("enforce");
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0]).toMatchObject({ label: "Laptop", current: true });
  });

  it("stops working once revoked, and must enrol again", async () => {
    const app = buildApp();
    const laptop = makeDevice();
    const enrol = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: laptop.publicKey });
    const cookie = (enrol.headers["set-cookie"] as string[])
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const deviceId = enrol.body.deviceId as string;

    const revoked = await request(app)
      .post(`/api/admin/devices/${deviceId}/revoke`)
      .set("Cookie", cookie)
      .set(
        proofHeaders(
          laptop,
          deviceId,
          "POST",
          `/api/admin/devices/${deviceId}/revoke`,
          { reason: "lost" }
        )
      )
      .send({ reason: "lost" });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revokedReason).toBe("lost");

    const after = await request(app)
      .get("/api/admin/loans")
      .set("Cookie", cookie)
      .set(proofHeaders(laptop, deviceId, "GET", "/api/admin/loans"));

    expect(after.status).toBe(401);
    expect(after.body.reason).toBe("device_revoked");
  });

  it("answers 404 when revoking a device that is not its own", async () => {
    const app = buildApp();
    const laptop = makeDevice();
    const enrol = await request(app)
      .post("/api/admin/devices/enroll")
      .set("Cookie", sessionCookie({}))
      .send({ publicKey: laptop.publicKey });
    const cookie = (enrol.headers["set-cookie"] as string[])
      .map((entry) => entry.split(";")[0])
      .join("; ");

    const foreign = enrollAdminDevice({
      adminAddress: OTHER_ADMIN,
      publicKey: makeDevice().publicKey,
    });

    const path = `/api/admin/devices/${foreign.deviceId}/revoke`;
    const res = await request(app)
      .post(path)
      .set("Cookie", cookie)
      .set(proofHeaders(laptop, enrol.body.deviceId, "POST", path))
      .send();

    expect(res.status).toBe(404);
  });
});

// ── Modes ────────────────────────────────────────────────────────────────

describe("enforcement modes", () => {
  it("off lets an unbound session straight through", async () => {
    process.env.ADMIN_DEVICE_BINDING = "off";

    const res = await request(buildApp()).get("/api/admin/loans").set("Cookie", sessionCookie({}));

    expect(res.status).toBe(200);
  });

  it("monitor serves the request but still audits the failure", async () => {
    process.env.ADMIN_DEVICE_BINDING = "monitor";

    const res = await request(buildApp()).get("/api/admin/loans").set("Cookie", sessionCookie({}));

    expect(res.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "admin.device_binding.failed",
        metadata: expect.objectContaining({ mode: "monitor", reason: "binding_not_configured" }),
      })
    );
  });

  it("exempts the static admin API key, which has no device", async () => {
    process.env.ADMIN_DEVICE_BINDING = "enforce";
    process.env.ADMIN_API_KEY = "server-to-server-key";

    const res = await request(buildBareApp())
      .get("/api/admin/loans")
      .set("Authorization", "Bearer server-to-server-key");

    expect(res.status).toBe(200);
    expect(logAudit).not.toHaveBeenCalled();

    delete process.env.ADMIN_API_KEY;
  });
});
