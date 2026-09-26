// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import crypto from "crypto";
import jwt, { JwtPayload, SignOptions } from "jsonwebtoken";

/**
 * JWT signing-key rotation with a grace period.
 *
 * A {@link JwtKeyRing} holds an ordered list of keys (newest first). Tokens are
 * always signed with the current key and carry its `kid` in the JWT header.
 * Verification accepts the current key plus any key retired less than
 * `gracePeriodSeconds` ago, so rotating the signing key never invalidates
 * sessions that are still inside the grace window. Keys whose grace period has
 * fully elapsed are rejected and pruned.
 */

export interface JwtKey {
  /** Key id stamped into the token header (`kid`). */
  kid: string;
  /** HMAC signing secret. */
  secret: string;
  /** Unix seconds when the key became current. */
  createdAt: number;
  /** Unix seconds when the key stopped being the signing key. */
  retiredAt?: number;
}

/** Default window during which the previous key keeps validating tokens. */
export const DEFAULT_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60;
/** Default interval between automatic rotations. */
export const DEFAULT_ROTATION_INTERVAL_SECONDS = 30 * 24 * 60 * 60;

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class JwtKeyRing {
  private keys: JwtKey[];
  private readonly gracePeriodSeconds: number;
  private readonly rotationIntervalSeconds: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: {
    keys: JwtKey[];
    gracePeriodSeconds?: number;
    rotationIntervalSeconds?: number;
  }) {
    if (opts.keys.length === 0) {
      throw new Error("JwtKeyRing requires at least one signing key");
    }
    this.keys = [...opts.keys].sort((a, b) => b.createdAt - a.createdAt);
    this.gracePeriodSeconds =
      opts.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS;
    this.rotationIntervalSeconds =
      opts.rotationIntervalSeconds ?? DEFAULT_ROTATION_INTERVAL_SECONDS;
  }

  get currentKey(): JwtKey {
    return this.keys[0];
  }

  get currentKid(): string {
    return this.currentKey.kid;
  }

  get gracePeriodSecondsValue(): number {
    return this.gracePeriodSeconds;
  }

  get rotationIntervalSecondsValue(): number {
    return this.rotationIntervalSeconds;
  }

  /** True once a key has been retired (replaced as the signing key). */
  isRetired(key: JwtKey): boolean {
    return typeof key.retiredAt === "number";
  }

  /** True while a retired key may still verify tokens. */
  isWithinGrace(key: JwtKey, now: number = nowSeconds()): boolean {
    return (
      this.isRetired(key) &&
      (key.retiredAt as number) + this.gracePeriodSeconds >= now
    );
  }

  /** True once a retired key's grace period has fully elapsed. */
  isExpired(key: JwtKey, now: number = nowSeconds()): boolean {
    return (
      this.isRetired(key) &&
      (key.retiredAt as number) + this.gracePeriodSeconds < now
    );
  }

  /** Keys that may verify a token right now: current + retired-within-grace. */
  activeKeys(now: number = nowSeconds()): JwtKey[] {
    return this.keys.filter(
      (key) => !this.isRetired(key) || this.isWithinGrace(key, now)
    );
  }

  /** Signs `payload` with the current key, stamping its `kid` into the header. */
  sign(payload: string | Buffer | object, options: SignOptions = {}): string {
    return jwt.sign(payload, this.currentKey.secret, {
      ...options,
      keyid: this.currentKey.kid,
    });
  }

  /**
   * Verifies `token` against the active keys. Honours the token's `kid` when
   * present; legacy tokens without a `kid` are checked against every active key
   * (newest first). Throws if no active key validates the token.
   */
  verify(token: string, now: number = nowSeconds()): JwtPayload {
    const decoded = jwt.decode(token, { complete: true }) as {
      header?: { kid?: unknown };
    } | null;
    const header = decoded?.header;
    const kid = header && typeof header.kid === "string" ? header.kid : undefined;

    const candidates = kid
      ? this.activeKeys(now).filter((key) => key.kid === kid)
      : this.activeKeys(now);

    if (candidates.length === 0) {
      throw new jwt.JsonWebTokenError("no active signing key for token");
    }

    let lastError: Error | undefined;
    for (const key of candidates) {
      try {
        return jwt.verify(token, key.secret) as JwtPayload;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new jwt.JsonWebTokenError("invalid token");
  }

  /**
   * Introduces a new current key and retires the former current key at `now`.
   * The retired key keeps verifying until its grace period elapses, so tokens
   * issued just before the rotation stay valid. Returns the new key; a secret
   * is generated when none is supplied.
   */
  rotate(
    now: number = nowSeconds(),
    next?: { secret?: string; kid?: string }
  ): JwtKey {
    const previous = this.currentKey;
    if (!this.isRetired(previous)) {
      previous.retiredAt = now;
    }
    const key: JwtKey = {
      kid: next?.kid ?? `k${now}-${this.keys.length}`,
      secret: next?.secret ?? crypto.randomBytes(32).toString("hex"),
      createdAt: now,
    };
    this.keys.unshift(key);
    this.prune(now);
    return key;
  }

  /**
   * Drops keys whose grace period has fully elapsed and returns their kids. The
   * current key is never retired, so it is always retained.
   */
  prune(now: number = nowSeconds()): string[] {
    const dropped = this.keys.filter((key) => this.isExpired(key, now));
    this.keys = this.keys.filter((key) => !this.isExpired(key, now));
    return dropped.map((key) => key.kid);
  }

  /** Read-only snapshot of the ring, newest first. */
  snapshot(): JwtKey[] {
    return this.keys.map((key) => ({ ...key }));
  }

  /** Rotates on a fixed interval until {@link stopScheduler} is called. */
  startScheduler(intervalSeconds: number = this.rotationIntervalSeconds): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.rotate();
    }, intervalSeconds * 1000);
    this.timer.unref?.();
  }

  stopScheduler(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Builds a ring from the environment:
 * - `JWT_SECRET` / `JWT_KEY_KID` — the current signing key
 * - `JWT_PREVIOUS_SECRETS` / `JWT_PREVIOUS_KEY_KIDS` — comma-separated keys
 *   that are still inside their grace period
 * - `JWT_KEY_GRACE_PERIOD_SECONDS` — how long a retired key keeps verifying
 * - `JWT_KEY_ROTATION_INTERVAL_SECONDS` — automatic rotation cadence
 */
export function loadKeyRingFromEnv(
  env: NodeJS.ProcessEnv = process.env
): JwtKeyRing {
  const now = nowSeconds();
  const currentSecret = env.JWT_SECRET || "default_jwt_secret";
  const currentKid = env.JWT_KEY_KID || "current";

  const previousSecrets = (env.JWT_PREVIOUS_SECRETS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const previousKids = (env.JWT_PREVIOUS_KEY_KIDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const keys: JwtKey[] = [
    { kid: currentKid, secret: currentSecret, createdAt: now },
    ...previousSecrets.map((secret, index) => ({
      kid: previousKids[index] || `previous-${index + 1}`,
      secret,
      createdAt: now - (index + 1),
      retiredAt: now,
    })),
  ];

  return new JwtKeyRing({
    keys,
    gracePeriodSeconds: intFromEnv(
      env.JWT_KEY_GRACE_PERIOD_SECONDS,
      DEFAULT_GRACE_PERIOD_SECONDS
    ),
    rotationIntervalSeconds: intFromEnv(
      env.JWT_KEY_ROTATION_INTERVAL_SECONDS,
      DEFAULT_ROTATION_INTERVAL_SECONDS
    ),
  });
}

let defaultRing: JwtKeyRing | null = null;

/** Lazily-built process-wide ring. */
export function getJwtKeyRing(): JwtKeyRing {
  if (!defaultRing) {
    defaultRing = loadKeyRingFromEnv();
  }
  return defaultRing;
}

/** Replaces the process-wide ring (rotation jobs and tests). */
export function setJwtKeyRing(ring: JwtKeyRing | null): void {
  defaultRing = ring;
}

/** Signs a session token with the process-wide ring's current key. */
export function signSessionToken(
  payload: object,
  options: SignOptions = {}
): string {
  return getJwtKeyRing().sign(payload, options);
}

/** Verifies a session token against the process-wide ring's active keys. */
export function verifySessionToken(token: string): JwtPayload {
  return getJwtKeyRing().verify(token);
}
