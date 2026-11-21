// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Route-level tests for the SIEM export's PII redaction level (issue #1104).
 * Redaction output itself is covered in auditSiemExport.test.ts.
 */

import express from "express";
import request from "supertest";
import { auditRouter } from "../routes/audit.js";
import { prisma } from "../services/db.js";

// Mock the entire db service so we can track prisma calls
jest.mock("../services/db.js", () => ({
  prisma: {
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
  },
}));

// Mock config for API key
jest.mock("../services/audit.js", () => ({ logAudit: jest.fn() }));

jest.mock("../config.js", () => ({
  loadConfig: () => ({
    adminApiKey: "test-admin-key",
  }),
}));

// Isolate the audit route's query/pagination logic (the subject of these
// tests) from `../middleware/auth.js`, which currently exports a duplicate
// `requireAdmin` declaration (a JWT-cookie admin gate shadows the intended
// Bearer-API-key gate documented on this route) — a pre-existing bug outside
// the scope of the audit-log pagination work. This mock reproduces the
// documented Bearer-key contract so these tests exercise the route itself.
jest.mock("../middleware/auth.js", () => ({
  // The audit router also mounts an auth-protected stream route; the mock must
  // provide every export the router imports or `router.post` receives
  // `undefined` and throws at import time.
  authMiddleware: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_authorization", message: "Authorization header is required" });
      return;
    }
    if (authHeader.slice(7) !== "test-admin-key") {
      res.status(403).json({ error: "forbidden", message: "Invalid admin credentials" });
      return;
    }
    next();
  },
}));

const app = express();
app.use(express.json());
app.use("/api/audit-logs", auditRouter);

const ROW = {
  id: "r-1",
  action: "loan.approved",
  actorAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  ipAddress: "203.0.113.45",
  metadata: { email: "borrower@example.com" },
  createdAt: new Date("2026-08-01T06:00:00Z"),
};

function exportRequest(body: Record<string, unknown>) {
  return request(app)
    .post("/api/audit-logs/siem-export")
    .set("Authorization", "Bearer test-admin-key")
    .send({ from: "2026-08-01T00:00:00Z", to: "2026-08-02T00:00:00Z", ...body });
}

describe("POST /api/audit-logs/siem-export redaction level", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.auditLog.findMany as jest.Mock).mockResolvedValueOnce([ROW]).mockResolvedValue([]);
  });

  it("defaults to the aggregate level when none is chosen", async () => {
    const res = await exportRequest({});
    expect(res.status).toBe(200);
    expect(res.headers["x-export-redaction-level"]).toBe("aggregate");
    expect(res.text).not.toContain(ROW.actorAddress);
    expect(res.text).not.toContain("borrower@example.com");
    expect(JSON.parse(res.text.trim())).toMatchObject({ action: "loan.approved", count: 1 });
  });

  it("honours an explicitly chosen full level", async () => {
    const res = await exportRequest({ redactionLevel: "full" });
    expect(res.status).toBe(200);
    expect(res.headers["x-export-redaction-level"]).toBe("full");
    expect(res.text).toContain(ROW.actorAddress);
    expect(res.text).toContain("borrower@example.com");
  });

  it("honours an explicitly chosen partial level", async () => {
    const res = await exportRequest({ redactionLevel: "partial" });
    expect(res.status).toBe(200);
    expect(res.headers["x-export-redaction-level"]).toBe("partial");
    expect(res.text).not.toContain(ROW.actorAddress);
    expect(res.text).not.toContain("borrower@example.com");
    expect(JSON.parse(res.text.trim()).ipAddress).toBe("203.0.113.0");
  });

  it("rejects an unknown redaction level before exporting anything", async () => {
    const res = await exportRequest({ redactionLevel: "everything" });
    expect(res.status).toBe(400);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });
});
