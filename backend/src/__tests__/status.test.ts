// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import {
  statusRouter,
  clearPublicStatusCache,
  PUBLIC_STATUS_CACHE_TTL_MS,
} from "../routes/status";
import * as db from "../services/db";
import { getRpcHealthMonitor } from "../services/rpcHealthMonitor";
import { markShuttingDown, resetShutdownState } from "../services/gracefulShutdown";

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

jest.mock("../services/rpcHealthMonitor", () => ({
  getRpcHealthMonitor: jest.fn(),
}));

const mockedQueryRaw = jest.mocked(db.prisma.$queryRaw);
const mockedGetMonitor = jest.mocked(getRpcHealthMonitor);

const checkOnce = jest.fn();

const app = express();
app.use("/api/status", statusRouter);

/** Configure the mocked RPC monitor to report the given aggregate health. */
function setRpcHealthy(healthy: boolean) {
  checkOnce.mockResolvedValue([{ url: "https://rpc.example", healthy }]);
}

describe("GET /api/status", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearPublicStatusCache();
    resetShutdownState();
    mockedGetMonitor.mockReturnValue({ checkOnce } as unknown as ReturnType<typeof getRpcHealthMonitor>);
    mockedQueryRaw.mockResolvedValue([{ "?column?": 1 }]);
    setRpcHealthy(true);
  });

  afterEach(() => {
    resetShutdownState();
  });

  it("reports every component up when all are healthy", async () => {
    const res = await request(app).get("/api/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "up",
      components: { api: "up", database: "up", rpc: "up" },
      timestamp: expect.any(String),
    });
  });

  it("reports only up/down and never leaks internal error details when the database is down", async () => {
    mockedQueryRaw.mockRejectedValue(new Error("Connection refused"));

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.components).toEqual({ api: "up", database: "down", rpc: "up" });
    // The internal probe's error string must not appear anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain("Connection refused");
  });

  it("reports the RPC component down and hides node details when RPC is unhealthy", async () => {
    setRpcHealthy(false);

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.components).toEqual({ api: "up", database: "up", rpc: "down" });
    // The probe's node URL is internal and must not be exposed publicly.
    expect(JSON.stringify(res.body)).not.toContain("rpc.example");
  });

  it("reports the API component down while the server is draining", async () => {
    markShuttingDown();

    const res = await request(app).get("/api/status");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("down");
    expect(res.body.components).toEqual({ api: "down", database: "up", rpc: "up" });
  });

  it("serves a repeated request within the cache window without re-running the probes", async () => {
    await request(app).get("/api/status");
    await request(app).get("/api/status");

    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);
    expect(checkOnce).toHaveBeenCalledTimes(1);
  });

  it("re-runs the probes once the cache window has elapsed", async () => {
    const nowSpy = jest.spyOn(Date, "now");

    nowSpy.mockReturnValue(1_000);
    await request(app).get("/api/status");

    nowSpy.mockReturnValue(1_000 + PUBLIC_STATUS_CACHE_TTL_MS + 1);
    await request(app).get("/api/status");

    expect(mockedQueryRaw).toHaveBeenCalledTimes(2);
    expect(checkOnce).toHaveBeenCalledTimes(2);

    nowSpy.mockRestore();
  });
});
