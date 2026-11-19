// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Adaptive CAPTCHA challenges (issue #934).
 *
 * A challenge is only demanded when risk signals are present for the request
 * source: repeated failures, a bad reputation, an unusual request rate, or an
 * active credential-stuffing lockout. Normal traffic is never challenged.
 *
 * Challenges are self-hosted text questions (screen-reader friendly by
 * construction, no third-party script). Solving one yields a signed token that
 * is verified server-side, bound to a single action and request source, and
 * single-use. Users who cannot solve a challenge are never dead-ended: after
 * repeated failed attempts an "assisted" path issues a token after a cooling
 * delay and surfaces a support contact.
 *
 * State is in-memory, matching services/credentialStuffing.ts; a multi-instance
 * deployment should set CAPTCHA_SECRET so tokens verify on any instance.
 */

import crypto from "node:crypto";
import { isStuffingSourceLocked } from "./credentialStuffing.js";
import logger from "../utils/logger.js";

export type CaptchaAction = string;

export type RiskReason =
  | "repeated_failures"
  | "bad_reputation"
  | "unusual_request_rate"
  | "credential_stuffing_lockout";

export interface RiskContext {
  action: CaptchaAction;
  /** Request source (normally req.ip). */
  source: string;
  asn?: string;
  fingerprint?: string;
}

export interface CaptchaOptions {
  windowMs?: number;
  failureThreshold?: number;
  requestRateThreshold?: number;
  challengeTtlMs?: number;
  tokenTtlMs?: number;
  maxSolveAttempts?: number;
  assistedDelayMs?: number;
  supportContact?: string;
  now?: () => number;
}

export interface Challenge {
  challengeId: string;
  action: CaptchaAction;
  type: "text";
  question: string;
  expiresAtMs: number;
}

interface ChallengeRecord {
  action: CaptchaAction;
  source: string;
  answerHash: string;
  expiresAtMs: number;
  createdAtMs: number;
  attempts: number;
}

interface SourceActivity {
  failures: number[];
  requests: number[];
}

const activity = new Map<string, SourceActivity>();
const challenges = new Map<string, ChallengeRecord>();
const usedTokens = new Map<string, number>();
const badReputation = new Set<string>();

const EPHEMERAL_SECRET = crypto.randomBytes(32).toString("hex");

function cfg(opts: CaptchaOptions = {}): Required<CaptchaOptions> {
  return {
    windowMs: Number(process.env.CAPTCHA_WINDOW_MS ?? 10 * 60 * 1000),
    failureThreshold: Number(process.env.CAPTCHA_FAILURE_THRESHOLD ?? 3),
    requestRateThreshold: Number(process.env.CAPTCHA_REQUEST_RATE_THRESHOLD ?? 30),
    challengeTtlMs: Number(process.env.CAPTCHA_CHALLENGE_TTL_MS ?? 5 * 60 * 1000),
    tokenTtlMs: Number(process.env.CAPTCHA_TOKEN_TTL_MS ?? 5 * 60 * 1000),
    maxSolveAttempts: Number(process.env.CAPTCHA_MAX_SOLVE_ATTEMPTS ?? 3),
    assistedDelayMs: Number(process.env.CAPTCHA_ASSISTED_DELAY_MS ?? 60 * 1000),
    supportContact: process.env.CAPTCHA_SUPPORT_CONTACT ?? "support@remitmortgage.com",
    now: () => Date.now(),
    ...opts,
  };
}

function secret(): string {
  return process.env.CAPTCHA_SECRET || EPHEMERAL_SECRET;
}

export function _clearCaptchaState(): void {
  activity.clear();
  challenges.clear();
  usedTokens.clear();
  badReputation.clear();
}

/** Mark a source as having a bad reputation (also seeded from CAPTCHA_BAD_SOURCES). */
export function flagBadReputation(source: string): void {
  badReputation.add(source.trim().toLowerCase());
}

function isBadReputation(source: string): boolean {
  const s = source.trim().toLowerCase();
  if (badReputation.has(s)) return true;
  const fromEnv = (process.env.CAPTCHA_BAD_SOURCES ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return fromEnv.includes(s);
}

function activityKey(ctx: Pick<RiskContext, "action" | "source">): string {
  return `${ctx.action}|${ctx.source.trim().toLowerCase()}`;
}

function getActivity(key: string, now: number, windowMs: number): SourceActivity {
  let a = activity.get(key);
  if (!a) {
    a = { failures: [], requests: [] };
    activity.set(key, a);
  }
  const cutoff = now - windowMs;
  a.failures = a.failures.filter((t) => t >= cutoff);
  a.requests = a.requests.filter((t) => t >= cutoff);
  return a;
}

/** Record an incoming request (feeds the unusual-request-rate signal). */
export function recordRequest(ctx: Pick<RiskContext, "action" | "source">, opts: CaptchaOptions = {}): void {
  const c = cfg(opts);
  getActivity(activityKey(ctx), c.now(), c.windowMs).requests.push(c.now());
}

/** Record a failed attempt for the action (feeds the repeated-failures signal). */
export function recordFailure(ctx: Pick<RiskContext, "action" | "source">, opts: CaptchaOptions = {}): void {
  const c = cfg(opts);
  getActivity(activityKey(ctx), c.now(), c.windowMs).failures.push(c.now());
}

/** Evaluate risk signals. Pure read: does not count the request itself. */
export function assessRisk(ctx: RiskContext, opts: CaptchaOptions = {}): { risky: boolean; reasons: RiskReason[] } {
  const c = cfg(opts);
  const now = c.now();
  const a = getActivity(activityKey(ctx), now, c.windowMs);
  const reasons: RiskReason[] = [];
  if (a.failures.length >= c.failureThreshold) reasons.push("repeated_failures");
  if (a.requests.length >= c.requestRateThreshold) reasons.push("unusual_request_rate");
  if (isBadReputation(ctx.source)) reasons.push("bad_reputation");
  try {
    if (isStuffingSourceLocked({ ip: ctx.source, asn: ctx.asn, fingerprint: ctx.fingerprint }, now).locked) {
      reasons.push("credential_stuffing_lockout");
    }
  } catch {
    // Signal source unavailable: do not escalate on its account.
  }
  return { risky: reasons.length > 0, reasons };
}

function hashAnswer(challengeId: string, answer: string): string {
  return crypto.createHmac("sha256", secret()).update(`${challengeId}:${answer}`).digest("hex");
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

function prune(now: number): void {
  for (const [id, rec] of challenges) if (rec.expiresAtMs <= now) challenges.delete(id);
  for (const [jti, exp] of usedTokens) if (exp <= now) usedTokens.delete(jti);
}

/** Issue a text challenge bound to an action and source. */
export function issueChallenge(ctx: Pick<RiskContext, "action" | "source">, opts: CaptchaOptions = {}): Challenge {
  const c = cfg(opts);
  const now = c.now();
  prune(now);
  const a = crypto.randomInt(1, 10);
  const b = crypto.randomInt(1, 11);
  const challengeId = crypto.randomUUID();
  const expiresAtMs = now + c.challengeTtlMs;
  challenges.set(challengeId, {
    action: ctx.action,
    source: ctx.source,
    answerHash: hashAnswer(challengeId, String(a + b)),
    expiresAtMs,
    createdAtMs: now,
    attempts: 0,
  });
  return {
    challengeId,
    action: ctx.action,
    type: "text",
    question: `What is ${WORDS[a]} plus ${WORDS[b]}? Answer with digits.`,
    expiresAtMs,
  };
}

function signToken(payload: { act: string; src: string; jti: string; exp: number }): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function mintToken(action: string, source: string, c: Required<CaptchaOptions>): string {
  return signToken({ act: action, src: source, jti: crypto.randomUUID(), exp: c.now() + c.tokenTtlMs });
}

export type SolveResult =
  | { ok: true; token: string; expiresInMs: number }
  | { ok: false; error: "challenge_not_found" | "challenge_expired" | "wrong_answer" | "source_mismatch" | "too_many_attempts"; assistedAvailable: boolean; supportContact: string };

/** Check an answer; a correct one consumes the challenge and yields an action-bound token. */
export function solveChallenge(
  challengeId: string,
  answer: string,
  source: string,
  opts: CaptchaOptions = {}
): SolveResult {
  const c = cfg(opts);
  const now = c.now();
  const fail = (error: Exclude<SolveResult, { ok: true }>["error"], assistedAvailable = false): SolveResult => ({
    ok: false,
    error,
    assistedAvailable,
    supportContact: c.supportContact,
  });
  const rec = challenges.get(challengeId);
  if (!rec) return fail("challenge_not_found");
  if (rec.expiresAtMs <= now) {
    challenges.delete(challengeId);
    return fail("challenge_expired");
  }
  if (rec.source !== source) return fail("source_mismatch");
  if (rec.attempts >= c.maxSolveAttempts) return fail("too_many_attempts", true);
  rec.attempts += 1;
  const given = hashAnswer(challengeId, String(answer ?? "").trim());
  const ok =
    given.length === rec.answerHash.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(rec.answerHash));
  if (!ok) {
    return fail("wrong_answer", rec.attempts >= c.maxSolveAttempts);
  }
  challenges.delete(challengeId);
  return { ok: true, token: mintToken(rec.action, source, c), expiresInMs: c.tokenTtlMs };
}

export type AssistedResult =
  | { ok: true; token: string; expiresInMs: number }
  | { ok: false; error: "challenge_not_found" | "source_mismatch" | "assisted_not_available" | "wait"; retryAfterMs?: number; supportContact: string };

/**
 * Accessible fallback for users who cannot complete the challenge. Available
 * once a challenge was failed repeatedly; yields a token after a cooling delay
 * so the user is never locked out, while keeping automated abuse slow.
 */
export function requestAssistedToken(challengeId: string, source: string, opts: CaptchaOptions = {}): AssistedResult {
  const c = cfg(opts);
  const now = c.now();
  const rec = challenges.get(challengeId);
  const base = { supportContact: c.supportContact };
  if (!rec || rec.expiresAtMs <= now) return { ok: false, error: "challenge_not_found", ...base };
  if (rec.source !== source) return { ok: false, error: "source_mismatch", ...base };
  if (rec.attempts < c.maxSolveAttempts) return { ok: false, error: "assisted_not_available", ...base };
  const readyAt = rec.createdAtMs + c.assistedDelayMs;
  if (now < readyAt) return { ok: false, error: "wait", retryAfterMs: readyAt - now, ...base };
  challenges.delete(challengeId);
  logger.info("[security] assisted captcha token issued", { action: rec.action, source });
  return { ok: true, token: mintToken(rec.action, source, c), expiresInMs: c.tokenTtlMs };
}

export type VerifyResult =
  | { valid: true; jti: string; exp: number }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_action" | "wrong_source" | "already_used" };

/**
 * Verify a token. With consume=true (default) a valid token is spent and can
 * never be replayed; consume=false only inspects it.
 */
export function verifyCaptchaToken(
  token: unknown,
  action: CaptchaAction,
  source: string,
  opts: CaptchaOptions & { consume?: boolean } = {}
): VerifyResult {
  const c = cfg(opts);
  const now = c.now();
  if (typeof token !== "string" || token.split(".").length !== 2) return { valid: false, reason: "malformed" };
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: "bad_signature" };
  let payload: { act: string; src: string; jti: string; exp: number };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { valid: false, reason: "malformed" };
  }
  if (payload.exp <= now) return { valid: false, reason: "expired" };
  if (payload.act !== action) return { valid: false, reason: "wrong_action" };
  if (payload.src !== source) return { valid: false, reason: "wrong_source" };
  if (usedTokens.has(payload.jti)) return { valid: false, reason: "already_used" };
  if (opts.consume !== false) usedTokens.set(payload.jti, payload.exp);
  return { valid: true, jti: payload.jti, exp: payload.exp };
}

/**
 * Non-consuming check that a token is authentic, unexpired, unspent and bound
 * to this source. The action binding is enforced where the token is spent
 * (adaptiveCaptcha middleware), so this is only for earlier gates that must
 * let a challenged user through to that point.
 */
export function peekCaptchaToken(token: unknown, source: string, opts: CaptchaOptions = {}): boolean {
  if (typeof token !== "string" || token.split(".").length !== 2) return false;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
    if (typeof payload?.act !== "string") return false;
    return verifyCaptchaToken(token, payload.act, source, { ...opts, consume: false }).valid;
  } catch {
    return false;
  }
}
