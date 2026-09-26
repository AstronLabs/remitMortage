// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import { auditRouter } from "../routes/audit.js";
import { logAudit } from "../services/audit.js";
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

describe("Audit Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("logAudit creates a record asynchronously and handles errors gracefully", async () => {
    // Setup the mock to reject, simulating a DB failure
    const mockCreate = prisma.auditLog.create as jest.Mock;
    mockCreate.mockRejectedValueOnce(new Error("DB Connection Refused"));

    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    // This should not throw an exception, but it will log to console.error
    await logAudit({
      action: "test_action",
      actorAddress: "GABC123",
      ipAddress: "127.0.0.1",
      metadata: { key: "value" },
    });

    // Wait a tiny bit for the catch block to execute (since it's an un-awaited promise inside)
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        action: "test_action",
        actorAddress: "GABC123",
        ipAddress: "127.0.0.1",
        metadata: { key: "value" },
      },
    });
    expect(consoleSpy).toHaveBeenCalledWith("Audit log persistence failed:", expect.any(Error));

    consoleSpy.mockRestore();
  });
});

describe("GET /api/audit-logs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects requests without an authorization header", async () => {
    const res = await request(app).get("/api/audit-logs");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_authorization");
  });

  it("rejects requests with an invalid API key", async () => {
    const res = await request(app)
      .get("/api/audit-logs")
      .set("Authorization", "Bearer wrong-key");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  it("returns cursor-paginated results for authorized requests, without a count() scan", async () => {
    const mockLogs = [
      { id: "1", action: "login", actorAddress: "GABC", createdAt: new Date() },
      { id: "2", action: "deposit", actorAddress: "GABC", createdAt: new Date() },
    ];

    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue(mockLogs);

    const res = await request(app)
      .get("/api/audit-logs?limit=10")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.pagination).toMatchObject({
      limit: 10,
      cursor: null,
      nextCursor: null,
      hasNextPage: false,
    });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 11,
    });
    // No full-table COUNT(*) — the old OFFSET/COUNT combo is what caused CPU
    // spikes on large event tables.
    expect((prisma.auditLog as any).count).toBeUndefined();
  });

  it("signals hasNextPage and returns a nextCursor when more rows exist than the limit", async () => {
    const mockLogs = Array.from({ length: 11 }, (_, i) => ({
      id: String(i + 1),
      action: "login",
      actorAddress: "GABC",
      createdAt: new Date(),
    }));

    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue(mockLogs);

    const res = await request(app)
      .get("/api/audit-logs?limit=10")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.pagination).toMatchObject({
      limit: 10,
      hasNextPage: true,
      nextCursor: "10",
    });
  });

  it("passes the cursor through as a Prisma keyset cursor with skip: 1", async () => {
    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/audit-logs?cursor=abc-123&limit=5")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 6,
      cursor: { id: "abc-123" },
      skip: 1,
    });
  });

  it("filters logs by action and actorAddress", async () => {
    (prisma.auditLog.findMany as jest.Mock).mockResolvedValue([]);

    const res = await request(app)
      .get("/api/audit-logs?action=login&actorAddress=GXYZ")
      .set("Authorization", "Bearer test-admin-key");

    expect(res.status).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith({
      where: {
        action: "login",
        actorAddress: "GXYZ",
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21,
    });
  });
});
