// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/** Adaptive CAPTCHA (issue #934): trigger conditions, verification, bypass attempts. */

import express from "express";
import request from "supertest";
import {
  _clearCaptchaState,
  assessRisk,
  flagBadReputation,
  issueChallenge,
  recordFailure,
  recordRequest,
  requestAssistedToken,
  solveChallenge,
  verifyCaptchaToken,
} from "../services/adaptiveCaptcha.js";
import { _clearCredentialStuffingState, recordCredentialFailure } from "../services/credentialStuffing.js";
import { adaptiveCaptcha } from "../middleware/adaptiveCaptcha.js";
import { captchaRouter } from "../routes/captcha.js";

const SRC = "198.51.100.7";

/** Solve the arithmetic question the way a human reading it would. */
function answerFor(question: string): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  const m = question.match(/What is (\w+) plus (\w+)\?/)!;
  return String(words.indexOf(m[1]) + words.indexOf(m[2]));
}

function solve(action: string, source = SRC, opts = {}) {
  const ch = issueChallenge({ action, source }, opts);
  const r = solveChallenge(ch.challengeId, answerFor(ch.question), source, opts);
  if (!r.ok) throw new Error("expected solve to succeed");
  return r.token;
}

beforeEach(() => {
  _clearCaptchaState();
  _clearCredentialStuffingState();
});

describe("risk triggers", () => {
  it("does not flag a normal user", () => {
    recordRequest({ action: "register", source: SRC });
    recordFailure({ action: "register", source: SRC });
    expect(assessRisk({ action: "register", source: SRC }).risky).toBe(false);
  });

  it("flags repeated failures", () => {
    for (let i = 0; i < 3; i++) recordFailure({ action: "register", source: SRC });
    expect(assessRisk({ action: "register", source: SRC }).reasons).toContain("repeated_failures");
  });

  it("scopes signals to the action and source", () => {
    for (let i = 0; i < 5; i++) recordFailure({ action: "register", source: SRC });
    expect(assessRisk({ action: "login", source: SRC }).risky).toBe(false);
    expect(assessRisk({ action: "register", source: "203.0.113.1" }).risky).toBe(false);
  });

  it("flags an unusual request rate", () => {
    for (let i = 0; i < 30; i++) recordRequest({ action: "register", source: SRC });
    expect(assessRisk({ action: "register", source: SRC }).reasons).toContain("unusual_request_rate");
  });

  it("flags bad reputation", () => {
    flagBadReputation(SRC);
    expect(assessRisk({ action: "register", source: SRC }).reasons).toContain("bad_reputation");
  });

  it("flags a source under credential-stuffing lockout", () => {
    for (let i = 0; i < 25; i++) {
      recordCredentialFailure({ account: `v${i}@example.com`, ip: SRC }, { onAlert: () => {} });
    }
    expect(assessRisk({ action: "register", source: SRC }).reasons).toContain("credential_stuffing_lockout");
  });

  it("expires old signals outside the window", () => {
    let t = 1_000_000;
    const opts = { now: () => t };
    for (let i = 0; i < 3; i++) recordFailure({ action: "register", source: SRC }, opts);
    t += 11 * 60 * 1000;
    expect(assessRisk({ action: "register", source: SRC }, opts).risky).toBe(false);
  });
});

describe("token verification", () => {
  it("accepts a valid token once, then rejects reuse", () => {
    const token = solve("register");
    expect(verifyCaptchaToken(token, "register", SRC).valid).toBe(true);
    expect(verifyCaptchaToken(token, "register", SRC)).toEqual({ valid: false, reason: "already_used" });
  });

  it("cannot be reused for another action", () => {
    const token = solve("register");
    expect(verifyCaptchaToken(token, "admin_2fa_verify", SRC)).toEqual({ valid: false, reason: "wrong_action" });
    // The failed cross-action attempt must not burn the token for its real action.
    expect(verifyCaptchaToken(token, "register", SRC).valid).toBe(true);
  });

  it("is bound to the source", () => {
    const token = solve("register");
    expect(verifyCaptchaToken(token, "register", "203.0.113.9")).toEqual({ valid: false, reason: "wrong_source" });
  });

  it("rejects forged, tampered, malformed and expired tokens", () => {
    const token = solve("register");
    const [body] = token.split(".");
    expect(verifyCaptchaToken(`${body}.forged`, "register", SRC).valid).toBe(false);
    const evil = Buffer.from(JSON.stringify({ act: "register", src: SRC, jti: "x", exp: Date.now() + 1e9 })).toString("base64url");
    expect(verifyCaptchaToken(`${evil}.${token.split(".")[1]}`, "register", SRC)).toEqual({ valid: false, reason: "bad_signature" });
    expect(verifyCaptchaToken("garbage", "register", SRC)).toEqual({ valid: false, reason: "malformed" });
    expect(verifyCaptchaToken(undefined, "register", SRC)).toEqual({ valid: false, reason: "malformed" });
    let t = 5_000_000;
    const opts = { now: () => t };
    const short = solve("register", SRC, opts);
    t += 6 * 60 * 1000;
    expect(verifyCaptchaToken(short, "register", SRC, opts)).toEqual({ valid: false, reason: "expired" });
  });
});

describe("challenge solving and accessible fallback", () => {
  it("rejects wrong answers and a challenge cannot be solved from another source", () => {
    const ch = issueChallenge({ action: "register", source: SRC });
    expect(solveChallenge(ch.challengeId, "999", SRC)).toMatchObject({ ok: false, error: "wrong_answer" });
    expect(solveChallenge(ch.challengeId, answerFor(ch.question), "203.0.113.9")).toMatchObject({ ok: false, error: "source_mismatch" });
  });

  it("a solved challenge cannot be solved twice", () => {
    const ch = issueChallenge({ action: "register", source: SRC });
    expect(solveChallenge(ch.challengeId, answerFor(ch.question), SRC).ok).toBe(true);
    expect(solveChallenge(ch.challengeId, answerFor(ch.question), SRC)).toMatchObject({ ok: false, error: "challenge_not_found" });
  });

  it("offers support contact and assisted path after repeated failures, then issues a token after the delay", () => {
    let t = 9_000_000;
    const opts = { now: () => t, assistedDelayMs: 60_000 };
    const ch = issueChallenge({ action: "register", source: SRC }, opts);
    expect(requestAssistedToken(ch.challengeId, SRC, opts)).toMatchObject({ ok: false, error: "assisted_not_available" });
    let last: any;
    for (let i = 0; i < 3; i++) last = solveChallenge(ch.challengeId, "nope", SRC, opts);
    expect(last).toMatchObject({ ok: false, assistedAvailable: true, supportContact: expect.any(String) });
    // Even the right answer is refused once attempts are exhausted; assisted is the way through.
    expect(solveChallenge(ch.challengeId, answerFor(ch.question), SRC, opts)).toMatchObject({ error: "too_many_attempts" });
    expect(requestAssistedToken(ch.challengeId, SRC, opts)).toMatchObject({ ok: false, error: "wait" });
    t += 61_000;
    const assisted = requestAssistedToken(ch.challengeId, SRC, opts);
    expect(assisted.ok).toBe(true);
    if (assisted.ok) expect(verifyCaptchaToken(assisted.token, "register", SRC, opts).valid).toBe(true);
  });
});

describe("middleware + routes (bypass attempts)", () => {
  function makeApp() {
    const app = express();
    app.set("trust proxy", true);
    app.use(express.json());
    app.use("/api/captcha", captchaRouter);
    app.post("/register", adaptiveCaptcha("register"), (req, res) =>
      req.body.fail ? res.status(400).json({ error: "bad" }) : res.status(201).json({ ok: true })
    );
    app.post("/other", adaptiveCaptcha("other"), (_req, res) => res.json({ ok: true }));
    return app;
  }
  const ip = (r: request.Test) => r.set("X-Forwarded-For", SRC);

  it("does not challenge a normal user", async () => {
    const res = await ip(request(makeApp()).post("/register").send({}));
    expect(res.status).toBe(201);
  });

  it("challenges after repeated failures, and an end-to-end solve lets the request through exactly once", async () => {
    const app = makeApp();
    for (let i = 0; i < 3; i++) await ip(request(app).post("/register").send({ fail: true }));
    const blocked = await ip(request(app).post("/register").send({}));
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "captcha_required", reasons: ["repeated_failures"] });
    const { challengeId, question } = blocked.body.challenge;

    const solved = await ip(request(app).post("/api/captcha/solve").send({ challengeId, answer: answerFor(question) }));
    expect(solved.status).toBe(200);
    const token = solved.body.token;

    const ok = await ip(request(app).post("/register").set("x-captcha-token", token).send({}));
    expect(ok.status).toBe(201);
    const replay = await ip(request(app).post("/register").set("x-captcha-token", token).send({}));
    expect(replay.status).toBe(403);
    expect(replay.body.tokenProblem).toBe("already_used");
  });

  it("rejects a token minted for a different action, a forged token, and a different source", async () => {
    const app = makeApp();
    flagBadReputation(SRC);
    const otherToken = solve("other");
    const wrongAction = await ip(request(app).post("/register").set("x-captcha-token", otherToken).send({}));
    expect(wrongAction.status).toBe(403);
    expect(wrongAction.body.tokenProblem).toBe("wrong_action");

    const forged = await ip(request(app).post("/register").send({ captchaToken: "a.b" }));
    expect(forged.status).toBe(403);

    const elsewhere = solve("register", "203.0.113.50");
    const wrongSource = await ip(request(app).post("/register").set("x-captcha-token", elsewhere).send({}));
    expect(wrongSource.body.tokenProblem).toBe("wrong_source");
  });

  it("validates route input", async () => {
    const app = makeApp();
    expect((await request(app).post("/api/captcha/challenge").send({})).status).toBe(400);
    expect((await request(app).post("/api/captcha/solve").send({})).status).toBe(400);
    expect((await request(app).post("/api/captcha/assisted").send({})).status).toBe(400);
  });
});
