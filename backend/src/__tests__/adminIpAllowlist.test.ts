// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { createHmac } from "crypto";
import logger from "../utils/logger";
import {
  ADMIN_IP_BYPASS_HEADER,
  createAdminIpAllowlist,
  loadAdminIpAllowlistConfig,
  resolveTrustProxy,
  type AdminIpAllowlistConfig,
  type TrustProxySetting,
} from "../middleware/adminIpAllowlist";
import { notFoundHandler } from "../middleware/notFound";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const SECRET = "test-bypass-secret-value-of-sufficient-length";

function configFor(env: Record<string, string | undefined>): AdminIpAllowlistConfig {
  return loadAdminIpAllowlistConfig(env as NodeJS.ProcessEnv);
}

/**
 * Mirrors how `index.ts` wires the gate: allowlist first, then auth, then the
 * route. `trust proxy` is enabled so a test can present any client address
 * through `X-Forwarded-For`.
 */
function buildApp(config: AdminIpAllowlistConfig, trustProxy: TrustProxySetting = true) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.use("/api/admin", createAdminIpAllowlist(config));
  // Stands in for authMiddleware. Because the gate is mounted ahead of it, a
  // blocked request must 404 rather than 401 — the 401 would prove the route
  // exists to a caller who is not even permitted to know that.
  app.use("/api/admin", (req, res, next) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: "unauthorized", statusCode: 401 });
      return;
    }
    next();
  });
  app.get("/api/admin/stats", (_req, res) => res.json({ ok: true }));
  // A second path and a POST handler exist so the signature-binding tests below
  // are discriminating: every rejected case would answer 200 if the gate let it
  // through, rather than 404 because the route was missing anyway.
  app.get("/api/admin/other", (_req, res) => res.json({ ok: true }));
  app.post("/api/admin/stats", (_req, res) => res.json({ ok: true }));
  app.use(notFoundHandler);
  return app;
}

/** Signs an override exactly as the operator's break-glass tool would. */
function signOverride(
  secret: string,
  method: string,
  path: string,
  ip: string,
  expiresAt: number,
): string {
  const message = `${method.toUpperCase()}\n${path}\n${ip}\n${expiresAt}`;
  return `${expiresAt}.${createHmac("sha256", secret).update(message).digest("hex")}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Default break-glass target: an operator off the allowlist, calling /api/admin/stats. */
const BYPASS_IP = "198.51.100.42";
const BYPASS_PATH = "/api/admin/stats";

/**
 * Mints an override token. `inSeconds` is relative to now; the override fields
 * exist so a test can bind the token to the wrong secret, path, method or host
 * and assert the signature no longer matches.
 */
function bypassToken(
  inSeconds: number,
  overrides: { secret?: string; method?: string; path?: string; ip?: string } = {},
): string {
  return signOverride(
    overrides.secret ?? SECRET,
    overrides.method ?? "GET",
    overrides.path ?? BYPASS_PATH,
    overrides.ip ?? BYPASS_IP,
    nowSeconds() + inSeconds,
  );
}

/** Everything but the timestamp, which varies per response. */
function shapeOf(body: unknown): unknown {
  const { timestamp, ...rest } = body as Record<string, unknown>;
  return rest;
}

beforeEach(() => jest.clearAllMocks());

describe("admin IP allowlist — allow/deny", () => {
  it("lets an allowlisted address through with no added friction", async () => {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: "10.0.0.0/8" }));
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "10.1.2.3")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rejects an address outside the allowlist with 404", async () => {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: "10.0.0.0/8" }));
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "203.0.113.7")
      .set("Authorization", "Bearer token");
    expect(res.status).toBe(404);
  });

  it("answers a blocked request identically to a path that does not exist", async () => {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: "10.0.0.0/8" }));
    const blocked = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "203.0.113.7")
      .set("Authorization", "Bearer token");
    const nonexistent = await request(app)
      .get("/api/admin/there-is-no-such-endpoint")
      .set("X-Forwarded-For", "10.1.2.3")
      .set("Authorization", "Bearer token");

    // Same status, same body, same content type — the blocked response must not
    // be distinguishable from an unknown route.
    expect(blocked.status).toBe(nonexistent.status);
    expect(blocked.headers["content-type"]).toBe(nonexistent.headers["content-type"]);
    expect(shapeOf(blocked.body)).toEqual(shapeOf(nonexistent.body));
  });

  it("rejects before authentication, so no 401/403 confirms the route exists", async () => {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: "10.0.0.0/8" }));
    const blocked = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "203.0.113.7");
    expect(blocked.status).toBe(404);
    expect(blocked.body.error).toBe("not_found");

    // An allowlisted caller still has to authenticate — the gate adds a
    // network check, it does not replace the role check.
    const unauthenticated = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "10.1.2.3");
    expect(unauthenticated.status).toBe(401);
  });

  it("is inert when ADMIN_IP_ALLOWLIST is unset or empty", async () => {
    for (const env of [{}, { ADMIN_IP_ALLOWLIST: "" }, { ADMIN_IP_ALLOWLIST: " , " }]) {
      const app = buildApp(configFor(env));
      const res = await request(app)
        .get("/api/admin/stats")
        .set("X-Forwarded-For", "198.51.100.99")
        .set("Authorization", "Bearer token");
      expect(res.status).toBe(200);
    }
  });

  it("records every rejection for operators", async () => {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: "10.0.0.0/8" }));
    await request(app).get("/api/admin/stats").set("X-Forwarded-For", "203.0.113.7");
    expect(logger.warn).toHaveBeenCalledWith(
      "Admin route rejected: client IP not in ADMIN_IP_ALLOWLIST",
      expect.objectContaining({ ip: "203.0.113.7", method: "GET", path: "/api/admin/stats" }),
    );
  });
});

describe("admin IP allowlist — CIDR parsing", () => {
  async function allowedFrom(entry: string, ip: string): Promise<boolean> {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: entry }));
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", ip)
      .set("Authorization", "Bearer token");
    return res.status === 200;
  }

  it("matches IPv4 ranges, single hosts and edge prefixes", async () => {
    expect(await allowedFrom("10.0.0.0/8", "10.255.255.254")).toBe(true);
    expect(await allowedFrom("10.0.0.0/8", "11.0.0.1")).toBe(false);
    expect(await allowedFrom("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(await allowedFrom("203.0.113.7", "203.0.113.8")).toBe(false);
    expect(await allowedFrom("192.168.1.128/25", "192.168.1.200")).toBe(true);
    expect(await allowedFrom("192.168.1.128/25", "192.168.1.127")).toBe(false);
    // /32 and /0 must not be broken by 32-bit shift wraparound.
    expect(await allowedFrom("0.0.0.0/0", "198.51.100.4")).toBe(true);
    expect(await allowedFrom("203.0.113.7/32", "203.0.113.7")).toBe(true);
  });

  it("accepts several entries at once", async () => {
    const entry = "10.0.0.0/8, 203.0.113.7,2001:db8::/32";
    expect(await allowedFrom(entry, "10.0.0.1")).toBe(true);
    expect(await allowedFrom(entry, "203.0.113.7")).toBe(true);
    expect(await allowedFrom(entry, "2001:db8:abcd::1")).toBe(true);
    expect(await allowedFrom(entry, "198.51.100.1")).toBe(false);
  });

  it("matches IPv6 ranges, including compressed and loopback forms", async () => {
    expect(await allowedFrom("2001:db8::/32", "2001:db8:1:2::5")).toBe(true);
    expect(await allowedFrom("2001:db8::/32", "2001:dba::1")).toBe(false);
    expect(await allowedFrom("::1/128", "::1")).toBe(true);
    expect(await allowedFrom("2001:db8::/0", "fe80::1")).toBe(true);
  });

  it("normalises an IPv4-mapped IPv6 peer to its IPv4 form", async () => {
    // A dual-stack server reports IPv4 clients as ::ffff:a.b.c.d; without the
    // normalisation an operator allowlisting their own IPv4 would be denied.
    expect(await allowedFrom("203.0.113.7", "::ffff:203.0.113.7")).toBe(true);
    expect(await allowedFrom("203.0.113.7", "::ffff:203.0.113.8")).toBe(false);
    expect(await allowedFrom("10.0.0.0/8", "::ffff:10.9.9.9")).toBe(true);
  });

  it("never matches across address families", async () => {
    expect(await allowedFrom("10.0.0.0/8", "2001:db8::1")).toBe(false);
    expect(await allowedFrom("::1/128", "10.0.0.1")).toBe(false);
  });

  it("drops malformed entries without widening the policy", async () => {
    const config = configFor({
      ADMIN_IP_ALLOWLIST: "10.0.0.0/8,not-an-ip,999.999.999.999,10.0.0.0/99,10.0.0.0/abc",
    });
    expect(config.ranges).toHaveLength(1);
    expect(config.invalidEntries).toEqual([
      "not-an-ip",
      "999.999.999.999",
      "10.0.0.0/99",
      "10.0.0.0/abc",
    ]);
    expect(config.enabled).toBe(true);

    const app = buildApp(config);
    expect(
      (
        await request(app)
          .get("/api/admin/stats")
          .set("X-Forwarded-For", "10.1.1.1")
          .set("Authorization", "Bearer token")
      ).status,
    ).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/admin/stats")
          .set("X-Forwarded-For", "198.51.100.1")
          .set("Authorization", "Bearer token")
      ).status,
    ).toBe(404);
  });

  it("stays disabled when every entry is malformed, rather than failing open", () => {
    const config = configFor({ ADMIN_IP_ALLOWLIST: "garbage,also-garbage" });
    expect(config.enabled).toBe(false);
    expect(config.invalidEntries).toHaveLength(2);
  });
});

describe("admin IP allowlist — emergency signed override", () => {
  function bypassApp(extraEnv: Record<string, string | undefined> = {}) {
    const config = configFor({
      ADMIN_IP_ALLOWLIST: "10.0.0.0/8",
      ADMIN_IP_BYPASS_SECRET: SECRET,
      ...extraEnv,
    });
    return buildApp(config);
  }

  it("admits a correctly signed, unexpired token from a non-allowlisted IP", async () => {
    const app = bypassApp();
    const token = bypassToken(300);
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, token);
    expect(res.status).toBe(200);
  });

  it("audits every successful override", async () => {
    const app = bypassApp();
    const token = bypassToken(300);
    await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, token);
    expect(logger.warn).toHaveBeenCalledWith(
      "Admin IP allowlist bypassed via signed override",
      expect.objectContaining({ ip: "198.51.100.42", path: "/api/admin/stats" }),
    );
  });

  it("rejects a token that is expired", async () => {
    const app = bypassApp();
    const token = bypassToken(-1);
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, token);
    expect(res.status).toBe(404);
  });

  it("rejects a token whose lifetime exceeds the configured ceiling", async () => {
    const app = bypassApp({ ADMIN_IP_BYPASS_TTL_SECONDS: "300" });
    const token = bypassToken(3600);
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, token);
    expect(res.status).toBe(404);
  });

  it("rejects a token with a tampered signature", async () => {
    const app = bypassApp();
    const token = bypassToken(300);
    const tampered = `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}`;
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, tampered);
    expect(res.status).toBe(404);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const app = bypassApp();
    const token = bypassToken(300, { secret: "a-completely-different-secret-value-here" });
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, token);
    expect(res.status).toBe(404);
  });

  it("binds the token to the request path", async () => {
    // Signed for /api/admin/stats, presented to /api/admin/other (a real route
    // that answers 200 when the gate admits the caller).
    const wrongPath = await request(bypassApp())
      .get("/api/admin/other")
      .set("X-Forwarded-For", BYPASS_IP)
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300));
    expect(wrongPath.status).toBe(404);

    // Control: the same token signed for the path actually being requested.
    const control = await request(bypassApp())
      .get("/api/admin/other")
      .set("X-Forwarded-For", BYPASS_IP)
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300, { path: "/api/admin/other" }));
    expect(control.status).toBe(200);
  });

  it("binds the token to the request method", async () => {
    const wrongMethod = await request(bypassApp())
      .post("/api/admin/stats")
      .set("X-Forwarded-For", BYPASS_IP)
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300));
    expect(wrongMethod.status).toBe(404);

    const control = await request(bypassApp())
      .post("/api/admin/stats")
      .set("X-Forwarded-For", BYPASS_IP)
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300, { method: "POST" }));
    expect(control.status).toBe(200);
  });

  it("binds the token to the requesting client IP", async () => {
    // Signed for .42, replayed from .43.
    const replayed = await request(bypassApp())
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.43")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300));
    expect(replayed.status).toBe(404);

    // Control: a token minted for the host actually presenting it.
    const control = await request(bypassApp())
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.43")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300, { ip: "198.51.100.43" }));
    expect(control.status).toBe(200);
  });

  it("ignores a query string when validating the signed path", async () => {
    // The signature covers the path, not the query, so paging parameters must
    // not invalidate an otherwise valid token.
    const res = await request(bypassApp())
      .get("/api/admin/stats?page=2&limit=50")
      .set("X-Forwarded-For", BYPASS_IP)
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300));
    expect(res.status).toBe(200);
  });

  it("treats a trailing slash as the same path", async () => {
    const res = await request(bypassApp())
      .get("/api/admin/stats/")
      .set("X-Forwarded-For", BYPASS_IP)
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, bypassToken(300));
    expect(res.status).toBe(200);
  });

  it("ignores malformed override headers", async () => {
    const app = bypassApp();
    for (const token of ["", "garbage", "abc.def", "12345", ".deadbeef", "notanumber.deadbeef"]) {
      const res = await request(app)
        .get("/api/admin/stats")
        .set("X-Forwarded-For", "198.51.100.42")
        .set("Authorization", "Bearer token")
        .set(ADMIN_IP_BYPASS_HEADER, token);
      expect(res.status).toBe(404);
    }
  });

  it("cannot be overridden when no secret is configured", async () => {
    const app = buildApp(configFor({ ADMIN_IP_ALLOWLIST: "10.0.0.0/8" }));
    const token = bypassToken(300);
    const res = await request(app)
      .get("/api/admin/stats")
      .set("X-Forwarded-For", "198.51.100.42")
      .set("Authorization", "Bearer token")
      .set(ADMIN_IP_BYPASS_HEADER, token);
    expect(res.status).toBe(404);
  });

  it("clamps the configured lifetime to the hard ceiling", () => {
    expect(configFor({ ADMIN_IP_BYPASS_TTL_SECONDS: "999999" }).bypassTtlSeconds).toBe(3600);
    expect(configFor({}).bypassTtlSeconds).toBe(900);
    expect(configFor({ ADMIN_IP_BYPASS_TTL_SECONDS: "nonsense" }).bypassTtlSeconds).toBe(900);
  });
});

describe("resolveTrustProxy", () => {
  it("trusts only the socket peer by default", () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "" })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "false" })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "0" })).toBe(false);
  });

  it("accepts a hop count, a subnet list, or true", () => {
    expect(resolveTrustProxy({ TRUST_PROXY: "1" })).toBe(1);
    expect(resolveTrustProxy({ TRUST_PROXY: "2" })).toBe(2);
    expect(resolveTrustProxy({ TRUST_PROXY: "true" })).toBe(true);
    expect(resolveTrustProxy({ TRUST_PROXY: "10.0.0.0/8,172.16.0.0/12" })).toBe(
      "10.0.0.0/8,172.16.0.0/12",
    );
  });
});
