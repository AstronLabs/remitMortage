import express from "express";
import request from "supertest";
import helmet from "helmet";

jest.mock("../config", () => ({
  loadConfig: () => ({
    allowedOrigins: ["http://localhost:3000"],
  }),
}));

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

jest.mock("../services/db.js", () => ({
  prisma: { $queryRaw: jest.fn() },
  upsertApplicant: jest.fn(),
  createVerificationResult: jest.fn(),
}));

const app = express();
app.use(helmet());
app.get("/api/test", (_req, res) => res.json({ ok: true }));

describe("Helmet security headers", () => {
  it("sets X-Frame-Options on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  it("sets X-Content-Type-Options on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["x-content-type-options"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets Strict-Transport-Security on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["strict-transport-security"]).toBeDefined();
  });

  it("sets X-DNS-Prefetch-Control on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
  });

  it("sets X-Download-Options on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["x-download-options"]).toBe("noopen");
  });

  it("sets X-Permitted-Cross-Domain-Policies on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["x-permitted-cross-domain-policies"]).toBe("none");
  });

  it("sets Referrer-Policy on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["referrer-policy"]).toBeDefined();
  });

  it("sets X-XSS-Protection on responses", async () => {
    const res = await request(app).get("/api/test");

    expect(res.headers["x-xss-protection"]).toBeDefined();
  });
});
