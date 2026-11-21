// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express from "express";
import request from "supertest";
import {
  RPC_DEGRADED_HEADER,
  RPC_RETRY_AFTER_SECONDS,
  STALE_DATA_HEADER,
  requireRpcAvailable,
  rpcDegradedMode,
} from "../middleware/rpcDegradedMode.js";
import {
  isRpcDegraded,
  resetRpcDegradedState,
  setRpcDegradedState,
} from "../services/rpcDegradedState.js";

const app = express();
app.use(express.json());
app.use(rpcDegradedMode());
app.get("/api/read", (_req, res) => res.json({ source: "database" }));
app.post("/api/write", requireRpcAvailable(), (_req, res) => res.json({ ok: true }));

beforeEach(() => {
  resetRpcDegradedState();
});

describe("Soroban RPC degraded mode (issue #984)", () => {
  it("serves reads normally while the RPC is healthy", async () => {
    const res = await request(app).get("/api/read");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ source: "database" });
    expect(res.headers[STALE_DATA_HEADER.toLowerCase()]).toBeUndefined();
    expect(res.headers[RPC_DEGRADED_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("keeps serving reads with a staleness marker while the RPC is down", async () => {
    setRpcDegradedState(true, "2026-11-20T12:00:00.000Z");

    const res = await request(app).get("/api/read");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ source: "database" });
    expect(res.headers[STALE_DATA_HEADER.toLowerCase()]).toBe("true");
    expect(res.headers[RPC_DEGRADED_HEADER.toLowerCase()]).toBe("true");
    expect(res.headers.warning).toMatch(/stale/i);
    expect(isRpcDegraded()).toBe(true);
  });

  it("rejects chain-dependent writes with a retryable 503 while degraded", async () => {
    setRpcDegradedState(true);

    const res = await request(app).post("/api/write").send({ amount: 10 });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      error: "rpc_unavailable",
      code: "rpc_unavailable",
      retryable: true,
      statusCode: 503,
      retryAfterSeconds: RPC_RETRY_AFTER_SECONDS,
    });
    expect(res.headers["retry-after"]).toBe(String(RPC_RETRY_AFTER_SECONDS));
    expect(res.headers[STALE_DATA_HEADER.toLowerCase()]).toBeUndefined();
  });

  it("returns to normal automatically when the probe succeeds again", async () => {
    setRpcDegradedState(true);
    expect((await request(app).post("/api/write")).status).toBe(503);

    setRpcDegradedState(false);

    const read = await request(app).get("/api/read");
    const write = await request(app).post("/api/write").send({ amount: 10 });

    expect(read.status).toBe(200);
    expect(read.headers[STALE_DATA_HEADER.toLowerCase()]).toBeUndefined();
    expect(write.status).toBe(200);
    expect(write.body).toEqual({ ok: true });
    expect(isRpcDegraded()).toBe(false);
  });
});
