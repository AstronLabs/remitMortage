// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { signSessionToken } from "../services/jwtKeyRing.js";
import { authMiddleware } from "../middleware/auth.js";
import { sessionsRouter } from "../routes/sessions.js";
import { clearUserSessions, createUserSession } from "../services/userSessions.js";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/sessions", authMiddleware, sessionsRouter);
  return app;
}

describe("Active session listing and remote revocation (#974)", () => {
  beforeEach(() => {
    clearUserSessions();
  });

  it("lists active sessions, revokes one, revokes all others, blocks cross-user revoke, and rejects revoked tokens", async () => {
    const app = buildApp();
    const alice = "GALICE_TEST_WALLET_1";
    const bob = "GBOB_TEST_WALLET_2";

    const s1 = createUserSession({
      walletAddress: alice,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/126.0",
      coarseLocation: "Lagos, NG",
    });
    const s2 = createUserSession({
      walletAddress: alice,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1",
      coarseLocation: "London, UK",
    });
    const s3 = createUserSession({
      walletAddress: alice,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0",
      coarseLocation: "Berlin, DE",
    });
    const bobSession = createUserSession({
      walletAddress: bob,
      userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/126.0",
      coarseLocation: "New York, US",
    });

    const tok1 = signSessionToken({ walletAddress: alice, network: "testnet", sid: s1.sessionId });
    const tok2 = signSessionToken({ walletAddress: alice, network: "testnet", sid: s2.sessionId });

    // 1. List active sessions for Alice (does not include Bob's)
    const listRes = await request(app)
      .get("/api/sessions")
      .set("Authorization", `Bearer ${tok1}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.sessions).toHaveLength(3);
    expect(listRes.body.sessions.find((s: any) => s.sessionId === s1.sessionId)).toMatchObject({
      current: true,
      coarseLocation: "Lagos, NG",
      deviceSummary: "Chrome on macOS",
    });

    // 2. Attempting to revoke Bob's session is rejected with 403
    const crossUserRes = await request(app)
      .delete(`/api/sessions/${bobSession.sessionId}`)
      .set("Authorization", `Bearer ${tok1}`);
    expect(crossUserRes.status).toBe(403);
    expect(crossUserRes.body.code).toBe("FORBIDDEN");

    // 3. Revoking one of Alice's sessions succeeds and rejects its token on next request
    const revokeOne = await request(app)
      .delete(`/api/sessions/${s2.sessionId}`)
      .set("Authorization", `Bearer ${tok1}`);
    expect(revokeOne.status).toBe(200);

    const revokedUse = await request(app)
      .get("/api/sessions")
      .set("Authorization", `Bearer ${tok2}`);
    expect(revokedUse.status).toBe(401);
    expect(revokedUse.body.code).toBe("SESSION_REVOKED");

    // 4. Revoking all other sessions leaves only s1 active
    const revokeOthers = await request(app)
      .post("/api/sessions/revoke-others")
      .set("Authorization", `Bearer ${tok1}`);
    expect(revokeOthers.status).toBe(200);
    expect(revokeOthers.body.revokedSessionIds).toEqual([s3.sessionId]);

    const afterList = await request(app)
      .get("/api/sessions")
      .set("Authorization", `Bearer ${tok1}`);
    expect(afterList.body.sessions.map((s: any) => s.sessionId)).toEqual([s1.sessionId]);
  });
});
