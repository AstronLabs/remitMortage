// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { signSessionToken } from "../services/jwtKeyRing.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  checkSession,
  clearUserSessions,
  createUserSession,
  touchSession,
} from "../services/userSessions.js";

const WALLET = "GSESSION_TIMEOUT_TEST";
const IDLE_MS = 5_000; // 5 seconds
const MAX_LIFE_MS = 10_000; // 10 seconds

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/protected", authMiddleware, (_req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe("Configurable idle and absolute session timeouts (#1028)", () => {
  let prevIdle: string | undefined;
  let prevMax: string | undefined;

  beforeAll(() => {
    prevIdle = process.env.SESSION_IDLE_TIMEOUT_MS;
    prevMax = process.env.SESSION_MAX_LIFETIME_MS;
    process.env.SESSION_IDLE_TIMEOUT_MS = String(IDLE_MS);
    process.env.SESSION_MAX_LIFETIME_MS = String(MAX_LIFE_MS);
  });

  afterAll(() => {
    if (prevIdle === undefined) delete process.env.SESSION_IDLE_TIMEOUT_MS;
    else process.env.SESSION_IDLE_TIMEOUT_MS = prevIdle;
    if (prevMax === undefined) delete process.env.SESSION_MAX_LIFETIME_MS;
    else process.env.SESSION_MAX_LIFETIME_MS = prevMax;
  });

  beforeEach(() => {
    clearUserSessions();
  });

  // ── Unit: checkSession + touchSession ──────────────────────────────────

  it("activity resets the idle clock — a touch inside the idle window keeps the session alive past the original idle expiry", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const session = createUserSession({ walletAddress: WALLET, now: t0 });

    // At t=4s (within the 5s idle window): session is active; touch resets the clock.
    const t4 = new Date(t0.getTime() + 4_000);
    expect(
      checkSession(session.sessionId, {
        idleTimeoutMs: IDLE_MS,
        maxLifetimeMs: MAX_LIFE_MS,
        now: t4,
      }).active
    ).toBe(true);
    touchSession(session.sessionId, t4);

    // At t=8s: without the touch at t=4s, idle would be 8s > 5s → expired.
    // With the touch, idle = 8 − 4 = 4s < 5s → still active.
    const t8 = new Date(t0.getTime() + 8_000);
    expect(
      checkSession(session.sessionId, {
        idleTimeoutMs: IDLE_MS,
        maxLifetimeMs: MAX_LIFE_MS,
        now: t8,
      }).active
    ).toBe(true);
  });

  it("idle expiry — no activity for longer than the idle timeout expires the session", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const session = createUserSession({ walletAddress: WALLET, now: t0 });

    // At t=6s (past the 5s idle): no touch since creation → expired.
    const t6 = new Date(t0.getTime() + 6_000);
    const result = checkSession(session.sessionId, {
      idleTimeoutMs: IDLE_MS,
      maxLifetimeMs: MAX_LIFE_MS,
      now: t6,
    });
    expect(result).toEqual({ active: false, reason: "idle_timeout" });
  });

  it("absolute maximum applies despite activity — frequent touches cannot extend past the max lifetime", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    const session = createUserSession({ walletAddress: WALLET, now: t0 });

    // Touch every 3s — each resets the idle clock (idle = 5s, so 3s < 5s).
    for (let t = 0; t <= 9_000; t += 3_000) {
      const now = new Date(t0.getTime() + t);
      const result = checkSession(session.sessionId, {
        idleTimeoutMs: IDLE_MS,
        maxLifetimeMs: MAX_LIFE_MS,
        now,
      });
      expect(result.active).toBe(true);
      touchSession(session.sessionId, now);
    }

    // At t=11s: idle = 11 − 9 = 2s < 5s (idle OK), but absolute = 11s > 10s → expired.
    const t11 = new Date(t0.getTime() + 11_000);
    const result = checkSession(session.sessionId, {
      idleTimeoutMs: IDLE_MS,
      maxLifetimeMs: MAX_LIFE_MS,
      now: t11,
    });
    expect(result).toEqual({ active: false, reason: "max_lifetime_exceeded" });
  });

  // ── Integration: middleware enforces the timeouts ─────────────────────

  it("middleware keeps a session alive when activity arrives within the idle window", async () => {
    jest.useFakeTimers();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      jest.setSystemTime(t0);

      const session = createUserSession({ walletAddress: WALLET });
      const token = signSessionToken({
        walletAddress: WALLET,
        network: "testnet",
        sid: session.sessionId,
      });
      const app = buildApp();

      // Request at t=0 — succeeds and touches the session.
      const r1 = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);
      expect(r1.status).toBe(200);

      // Request at t=4s (within the 5s idle window) — touches and resets the clock.
      jest.setSystemTime(new Date(t0.getTime() + 4_000));
      const r2 = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);
      expect(r2.status).toBe(200);

      // At t=8s: without the touch at t=4s, idle would be 8s > 5s → expired.
      // With the touch, idle = 8 − 4 = 4s < 5s → still active.
      jest.setSystemTime(new Date(t0.getTime() + 8_000));
      const r3 = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);
      expect(r3.status).toBe(200);
    } finally {
      jest.useRealTimers();
    }
  });

  it("middleware returns 401 SESSION_EXPIRED when the idle timeout is exceeded with no activity", async () => {
    jest.useFakeTimers();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      jest.setSystemTime(t0);

      const session = createUserSession({ walletAddress: WALLET });
      const token = signSessionToken({
        walletAddress: WALLET,
        network: "testnet",
        sid: session.sessionId,
      });
      const app = buildApp();

      // Request at t=0 — succeeds and touches the session.
      const r1 = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);
      expect(r1.status).toBe(200);

      // Advance past the idle timeout (6s > 5s) with no intervening request.
      jest.setSystemTime(new Date(t0.getTime() + 6_000));
      const r2 = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);
      expect(r2.status).toBe(401);
      expect(r2.body.code).toBe("SESSION_EXPIRED");
    } finally {
      jest.useRealTimers();
    }
  });

  it("middleware enforces the absolute max despite continuous activity", async () => {
    jest.useFakeTimers();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      jest.setSystemTime(t0);

      const session = createUserSession({ walletAddress: WALLET });
      const token = signSessionToken({
        walletAddress: WALLET,
        network: "testnet",
        sid: session.sessionId,
      });
      const app = buildApp();

      // Requests every 3s — each resets the idle clock (idle = 5s, 3s < 5s),
      // but the absolute max (10s) is never extended.
      for (let t = 0; t <= 9_000; t += 3_000) {
        jest.setSystemTime(new Date(t0.getTime() + t));
        const r = await request(app)
          .get("/api/protected")
          .set("Authorization", `Bearer ${token}`);
        expect(r.status).toBe(200);
      }

      // At t=11s: idle = 2s < 5s (idle OK), but absolute = 11s > 10s → expired.
      jest.setSystemTime(new Date(t0.getTime() + 11_000));
      const r = await request(app)
        .get("/api/protected")
        .set("Authorization", `Bearer ${token}`);
      expect(r.status).toBe(401);
      expect(r.body.code).toBe("SESSION_EXPIRED");
    } finally {
      jest.useRealTimers();
    }
  });
});
