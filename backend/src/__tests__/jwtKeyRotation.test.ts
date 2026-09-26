// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import { authMiddleware } from "../middleware/auth";
import {
  DEFAULT_GRACE_PERIOD_SECONDS,
  JwtKey,
  JwtKeyRing,
  getJwtKeyRing,
  loadKeyRingFromEnv,
  nowSeconds,
  setJwtKeyRing,
  signSessionToken,
  verifySessionToken,
} from "../services/jwtKeyRing";
import {
  runJwtKeyRotationSweep,
  startJwtKeyRotationScheduler,
  stopJwtKeyRotationScheduler,
} from "../jobs/jwtKeyRotation";

const CURRENT_SECRET = "current-secret-0000000000000000000000";
const PREVIOUS_SECRET = "previous-secret-00000000000000000000";

function ringWith(keys: JwtKey[], gracePeriodSeconds = 1_000) {
  return new JwtKeyRing({ keys, gracePeriodSeconds });
}

function headerKid(token: string): string | undefined {
  const decoded = jwt.decode(token, { complete: true }) as {
    header?: { kid?: string };
  } | null;
  return decoded?.header?.kid;
}

describe("JwtKeyRing", () => {
  afterEach(() => {
    setJwtKeyRing(null);
    stopJwtKeyRotationScheduler();
    delete process.env.JWT_SECRET;
    delete process.env.JWT_KEY_KID;
    delete process.env.JWT_PREVIOUS_SECRETS;
    delete process.env.JWT_PREVIOUS_KEY_KIDS;
    delete process.env.JWT_KEY_GRACE_PERIOD_SECONDS;
    delete process.env.JWT_KEY_ROTATION_INTERVAL_SECONDS;
  });

  it("requires at least one key", () => {
    expect(() => new JwtKeyRing({ keys: [] })).toThrow(/at least one/);
  });

  it("signs with the current key and stamps its kid", () => {
    const ring = ringWith([{ kid: "k2", secret: CURRENT_SECRET, createdAt: 2 }]);
    const token = ring.sign({ walletAddress: "GAAA", network: "stellar" });

    expect(headerKid(token)).toBe("k2");
    expect(ring.currentKid).toBe("k2");
  });

  it("verifies tokens signed under the current and the previous key", () => {
    const now = 10_000;
    const ring = ringWith([
      { kid: "k2", secret: CURRENT_SECRET, createdAt: now },
      {
        kid: "k1",
        secret: PREVIOUS_SECRET,
        createdAt: now - 100,
        retiredAt: now - 100,
      },
    ]);

    const currentToken = jwt.sign({ walletAddress: "GNEW" }, CURRENT_SECRET, {
      keyid: "k2",
    });
    const previousToken = jwt.sign({ walletAddress: "GOLD" }, PREVIOUS_SECRET, {
      keyid: "k1",
    });

    expect(ring.verify(currentToken, now).walletAddress).toBe("GNEW");
    expect(ring.verify(previousToken, now).walletAddress).toBe("GOLD");
  });

  it("rejects a token whose key's grace period has fully elapsed", () => {
    const now = 10_000;
    const ring = ringWith([
      { kid: "k2", secret: CURRENT_SECRET, createdAt: now },
      {
        kid: "k1",
        secret: PREVIOUS_SECRET,
        createdAt: now - 5_000,
        retiredAt: now - 5_000,
      },
    ]);
    const staleToken = jwt.sign({ walletAddress: "GOLD" }, PREVIOUS_SECRET, {
      keyid: "k1",
    });

    expect(() => ring.verify(staleToken, now)).toThrow();
    expect(ring.isExpired(ring.snapshot()[1], now)).toBe(true);
  });

  it("rotating does not invalidate sessions issued under the prior key", () => {
    const t = 50_000;
    const ring = ringWith([{ kid: "k1", secret: PREVIOUS_SECRET, createdAt: t }]);

    const preRotation = ring.sign({ walletAddress: "GSESSION" });
    expect(headerKid(preRotation)).toBe("k1");

    const newKey = ring.rotate(t + 10, { secret: CURRENT_SECRET });

    // The session token from before the rotation is still accepted inside the
    // grace window...
    expect(ring.verify(preRotation, t + 20).walletAddress).toBe("GSESSION");
    // ...and newly issued tokens use the new key.
    expect(headerKid(ring.sign({ walletAddress: "GNEW" }))).toBe(newKey.kid);
    expect(ring.currentKid).toBe(newKey.kid);
  });

  it("prunes a retired key only once its grace period is over", () => {
    const ring = ringWith(
      [{ kid: "k1", secret: PREVIOUS_SECRET, createdAt: 0 }],
      100
    );
    const token = ring.sign({ walletAddress: "GOLD" });

    ring.rotate(1_000);

    // Still within grace: no pruning, token accepted.
    expect(ring.prune(1_050)).toHaveLength(0);
    expect(ring.verify(token, 1_050).walletAddress).toBe("GOLD");

    // Past grace: pruned, token rejected.
    expect(ring.prune(1_200)).toContain("k1");
    expect(() => ring.verify(token, 1_200)).toThrow();
  });

  it("falls back to all active keys for legacy tokens without a kid", () => {
    const now = 20_000;
    const ring = ringWith([
      { kid: "k2", secret: CURRENT_SECRET, createdAt: now },
      {
        kid: "k1",
        secret: PREVIOUS_SECRET,
        createdAt: now - 10,
        retiredAt: now - 10,
      },
    ]);
    const legacyToken = jwt.sign({ walletAddress: "GLEGACY" }, PREVIOUS_SECRET);

    expect(headerKid(legacyToken)).toBeUndefined();
    expect(ring.verify(legacyToken, now).walletAddress).toBe("GLEGACY");
  });

  it("rejects a token whose kid is not in the active ring", () => {
    const ring = ringWith([{ kid: "k2", secret: CURRENT_SECRET, createdAt: 1 }]);
    const ghost = jwt.sign({ walletAddress: "GGHOST" }, PREVIOUS_SECRET, {
      keyid: "ghost",
    });

    expect(() => ring.verify(ghost)).toThrow();
  });

  it("returns defensive snapshots and exposes its configuration", () => {
    const ring = ringWith(
      [{ kid: "k1", secret: PREVIOUS_SECRET, createdAt: 1 }],
      123
    );
    const snapshot = ring.snapshot();
    snapshot[0].secret = "mutated";

    expect(ring.snapshot()[0].secret).toBe(PREVIOUS_SECRET);
    expect(ring.gracePeriodSecondsValue).toBe(123);
  });

  it("starts and stops its rotation scheduler", () => {
    const ring = ringWith([{ kid: "k1", secret: PREVIOUS_SECRET, createdAt: 1 }]);
    ring.startScheduler(3_600);
    ring.startScheduler(3_600); // idempotent
    ring.stopScheduler();
    ring.stopScheduler(); // idempotent
  });
});

describe("loadKeyRingFromEnv", () => {
  afterEach(() => setJwtKeyRing(null));

  it("loads the current key and keeps previous keys within grace", () => {
    const ring = loadKeyRingFromEnv({
      JWT_SECRET: CURRENT_SECRET,
      JWT_KEY_KID: "live",
      JWT_PREVIOUS_SECRETS: `${PREVIOUS_SECRET},third-secret-xxxxxxxxxxxxxxxxxxxxx`,
      JWT_PREVIOUS_KEY_KIDS: "old,older",
      JWT_KEY_GRACE_PERIOD_SECONDS: "1000",
    });

    expect(ring.currentKid).toBe("live");
    const previousToken = jwt.sign({ walletAddress: "GOLD" }, PREVIOUS_SECRET, {
      keyid: "old",
    });
    expect(ring.verify(previousToken, nowSeconds()).walletAddress).toBe("GOLD");
    expect(ring.snapshot().map((key) => key.kid)).toEqual([
      "live",
      "old",
      "older",
    ]);
  });
});

describe("session token helpers", () => {
  afterEach(() => setJwtKeyRing(null));

  it("sign and verify through the process-wide ring", () => {
    setJwtKeyRing(
      new JwtKeyRing({
        keys: [{ kid: "k1", secret: CURRENT_SECRET, createdAt: nowSeconds() }],
      })
    );

    const token = signSessionToken(
      { walletAddress: "GAAA", network: "stellar" },
      { expiresIn: "1h" }
    );
    expect(headerKid(token)).toBe("k1");
    expect(verifySessionToken(token).walletAddress).toBe("GAAA");
    expect(getJwtKeyRing().currentKid).toBe("k1");
  });
});

describe("runJwtKeyRotationSweep", () => {
  afterEach(() => {
    setJwtKeyRing(null);
    delete process.env.JWT_KEY_ROTATION_INTERVAL_SECONDS;
  });

  it("rotates only once the current key reaches the rotation interval", () => {
    const now = 1_000_000;
    setJwtKeyRing(
      new JwtKeyRing({
        keys: [{ kid: "k1", secret: PREVIOUS_SECRET, createdAt: now }],
        gracePeriodSeconds: 1_000,
        rotationIntervalSeconds: 100,
      })
    );
    process.env.JWT_KEY_ROTATION_INTERVAL_SECONDS = "100";

    expect(runJwtKeyRotationSweep(now + 50).rotated).toBe(false);

    const swept = runJwtKeyRotationSweep(now + 150);
    expect(swept.rotated).toBe(true);

    // The retired key is still valid immediately after rotation...
    expect(
      getJwtKeyRing().verify(
        jwt.sign({ walletAddress: "GOLD" }, PREVIOUS_SECRET, { keyid: "k1" }),
        now + 150
      ).walletAddress
    ).toBe("GOLD");

    // ...and is pruned by a later sweep once the grace period elapses.
    const later = runJwtKeyRotationSweep(now + 150 + 2_000);
    expect(later.pruned).toContain("k1");
  });

  it("starts the cron scheduler idempotently", () => {
    setJwtKeyRing(
      new JwtKeyRing({
        keys: [{ kid: "k1", secret: PREVIOUS_SECRET, createdAt: nowSeconds() }],
      })
    );
    startJwtKeyRotationScheduler();
    startJwtKeyRotationScheduler();
    stopJwtKeyRotationScheduler();
  });
});

describe("auth middleware integration", () => {
  afterEach(() => setJwtKeyRing(null));

  it("accepts a token signed by the previous key during the grace period", async () => {
    const now = nowSeconds();
    setJwtKeyRing(
      new JwtKeyRing({
        keys: [
          { kid: "k2", secret: CURRENT_SECRET, createdAt: now },
          {
            kid: "k1",
            secret: PREVIOUS_SECRET,
            createdAt: now - 100,
            retiredAt: now - 100,
          },
        ],
        gracePeriodSeconds: DEFAULT_GRACE_PERIOD_SECONDS,
      })
    );

    const app = express();
    app.use(cookieParser());
    app.get("/protected", authMiddleware, (req: any, res: any) => {
      res.json({ user: req.user });
    });

    const previousToken = jwt.sign(
      { walletAddress: "GOLD", network: "stellar" },
      PREVIOUS_SECRET,
      { keyid: "k1" }
    );

    const res = await request(app)
      .get("/protected")
      .set("Cookie", [`token=${previousToken}`]);

    expect(res.status).toBe(200);
    expect(res.body.user.walletAddress).toBe("GOLD");
  });
});
