import express from "express";
import request from "supertest";
import { healthRouter } from "../routes/health";
import * as db from "../services/db";

jest.mock("../services/db", () => ({
  prisma: {
    $queryRaw: jest.fn(),
  },
}));

jest.mock("../config", () => ({
  loadConfig: () => ({
    horizonUrl: "https://horizon-testnet.stellar.org",
  }),
}));

const mockedQueryRaw = jest.mocked(db.prisma.$queryRaw);

const app = express();
app.use("/api/health", healthRouter);

describe("GET /api/health", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 200 when all components are healthy", async () => {
    mockedQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("remitmortgage-api");
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.components.database.status).toBe("healthy");
    expect(res.body.components.horizon.status).toBe("healthy");
    expect(res.body.components.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(res.body.components.horizon.latencyMs).toBeGreaterThanOrEqual(0);

    (global.fetch as jest.Mock).mockRestore();
  });

  it("returns 503 when database is unhealthy", async () => {
    mockedQueryRaw.mockRejectedValue(new Error("Connection refused"));

    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.components.database.status).toBe("unhealthy");
    expect(res.body.components.database.error).toBe("Connection refused");
    expect(res.body.components.horizon.status).toBe("healthy");

    (global.fetch as jest.Mock).mockRestore();
  });

  it("returns 503 when Horizon is unhealthy", async () => {
    mockedQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.components.database.status).toBe("healthy");
    expect(res.body.components.horizon.status).toBe("unhealthy");
    expect(res.body.components.horizon.error).toBe("Network error");

    (global.fetch as jest.Mock).mockRestore();
  });

  it("returns 503 when Horizon returns non-OK HTTP status", async () => {
    mockedQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 502 });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body.components.horizon.status).toBe("unhealthy");
    expect(res.body.components.horizon.error).toBe("HTTP 502");

    (global.fetch as jest.Mock).mockRestore();
  });

  it("returns 503 when both components are unhealthy", async () => {
    mockedQueryRaw.mockRejectedValue(new Error("DB timeout"));

    global.fetch = jest.fn().mockRejectedValue(new Error("Horizon down"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
    expect(res.body.components.database.status).toBe("unhealthy");
    expect(res.body.components.horizon.status).toBe("unhealthy");

    (global.fetch as jest.Mock).mockRestore();
  });
});
