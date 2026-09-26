import express from "express";
import request from "supertest";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";

const isImpersonationSessionActiveMock = jest.fn();

jest.mock("../services/impersonation.js", () => ({
  IMPERSONATION_COOKIE: "impersonation_token",
  isImpersonationSessionActive: (...args: unknown[]) => isImpersonationSessionActiveMock(...args),
}));

import { authMiddleware, AuthenticatedRequest } from "../middleware/auth";

const JWT_SECRET = process.env.JWT_SECRET || "default_jwt_secret";
const ADMIN = "GADMIN1111111111111111111111111111111111111111111111";
const TARGET = "GTARGET2222222222222222222222222222222222222222222222";

function signImpersonationToken(overrides: Partial<{ sessionId: string; adminAddress: string }> = {}) {
  return jwt.sign(
    {
      walletAddress: TARGET,
      network: "testnet",
      impersonation: {
        sessionId: overrides.sessionId ?? "session-1",
        adminAddress: overrides.adminAddress ?? ADMIN,
        readOnly: true,
      },
    },
    JWT_SECRET,
    { expiresIn: "15m" }
  );
}

describe("authMiddleware — read-only impersonation enforcement", () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = express();
    app.use(express.json());
    app.use(cookieParser());

    const handler = (req: AuthenticatedRequest, res: express.Response) =>
      res.json({ message: "ok", user: req.user });

    app.get("/resource", authMiddleware as express.RequestHandler, handler);
    app.post("/resource", authMiddleware as express.RequestHandler, handler);
    app.put("/resource", authMiddleware as express.RequestHandler, handler);
    app.delete("/resource", authMiddleware as express.RequestHandler, handler);
  });

  it("allows a GET through an active impersonation session and identifies the impersonated user", async () => {
    isImpersonationSessionActiveMock.mockResolvedValue(true);
    const token = signImpersonationToken();

    const res = await request(app).get("/resource").set("Cookie", [`impersonation_token=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.user.walletAddress).toBe(TARGET);
    expect(res.body.user.impersonation).toEqual({
      sessionId: "session-1",
      adminAddress: ADMIN,
      readOnly: true,
    });
  });

  it.each(["post", "put", "delete"] as const)(
    "blocks a %s request during an active impersonation session",
    async (method) => {
      isImpersonationSessionActiveMock.mockResolvedValue(true);
      const token = signImpersonationToken();

      const res = await (request(app)[method]("/resource") as request.Test).set("Cookie", [
        `impersonation_token=${token}`,
      ]);

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("read_only_impersonation");
    }
  );

  it("rejects requests once the impersonation session has ended or expired server-side", async () => {
    // The JWT itself is still signature-valid and unexpired, but the session
    // was explicitly ended (or expired) in the database — the DB check must
    // still catch a replayed cookie.
    isImpersonationSessionActiveMock.mockResolvedValue(false);
    const token = signImpersonationToken();

    const res = await request(app).get("/resource").set("Cookie", [`impersonation_token=${token}`]);

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("impersonation_session_ended");
  });

  it("rejects a forged or malformed impersonation cookie", async () => {
    const res = await request(app)
      .get("/resource")
      .set("Cookie", ["impersonation_token=not-a-real-jwt"]);

    expect(res.status).toBe(401);
    expect(isImpersonationSessionActiveMock).not.toHaveBeenCalled();
  });

  it("prefers the impersonation cookie over the admin's own login cookie when both are present", async () => {
    isImpersonationSessionActiveMock.mockResolvedValue(true);
    const impersonationToken = signImpersonationToken();
    const adminToken = jwt.sign({ walletAddress: ADMIN, network: "testnet" }, JWT_SECRET, {
      expiresIn: "24h",
    });

    const res = await request(app)
      .get("/resource")
      .set("Cookie", [`token=${adminToken}`, `impersonation_token=${impersonationToken}`]);

    expect(res.status).toBe(200);
    // Identity resolves to the impersonated target, not the admin's own session.
    expect(res.body.user.walletAddress).toBe(TARGET);
  });

  it("falls back to the normal login cookie when no impersonation cookie is present", async () => {
    const token = jwt.sign({ walletAddress: ADMIN, network: "testnet" }, JWT_SECRET, {
      expiresIn: "24h",
    });

    const res = await request(app).post("/resource").set("Cookie", [`token=${token}`]);

    // A mutating request on the admin's own (non-impersonation) session is
    // unaffected by the read-only gate.
    expect(res.status).toBe(200);
    expect(res.body.user.walletAddress).toBe(ADMIN);
    expect(isImpersonationSessionActiveMock).not.toHaveBeenCalled();
  });
});
