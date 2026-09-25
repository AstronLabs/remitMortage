// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js", () => ({
  prisma: {
    apiKey: { findUnique: jest.fn() },
    escrowDeposit: { findMany: jest.fn() },
    escrowWithdrawal: { findMany: jest.fn() },
    loanDisbursement: { findMany: jest.fn() },
    loanRepayment: { findMany: jest.fn() },
  },
}));

import express from "express";
import request from "supertest";
import { prisma } from "../services/db.js";
import { exportsRouter } from "../routes/exports";

const app = express();
app.use("/api/exports", exportsRouter);

const validKey = { id: "key-1", key: "rm_test", scopes: ["export:transactions"], revoked: false };

describe("GET /api/exports/transactions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(validKey);
  });

  it("requires an API key with the export:transactions scope", async () => {
    expect((await request(app).get("/api/exports/transactions")).status).toBe(401);

    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue({ ...validKey, scopes: ["read:loans"] });
    const res = await request(app).get("/api/exports/transactions").set("Authorization", "Bearer rm_test");
    expect(res.status).toBe(403);
  });

  it("returns the requested transaction rows ordered by ledger", async () => {
    const rows = [{ id: "r1", ledger: 10 }, { id: "r2", ledger: 11 }];
    (prisma.escrowDeposit.findMany as jest.Mock).mockResolvedValue(rows);

    const res = await request(app)
      .get("/api/exports/transactions?type=deposits&fromLedger=10&limit=2")
      .set("Authorization", "Bearer rm_test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "deposits", count: 2, rows });
    expect(prisma.escrowDeposit.findMany).toHaveBeenCalledWith({
      where: { ledger: { gte: 10 } },
      orderBy: [{ ledger: "asc" }, { id: "asc" }],
      take: 2,
    });
    expect(res.headers["x-export-quota-limit"]).toBeDefined();
  });

  it("rejects invalid type and query parameters", async () => {
    const badType = await request(app)
      .get("/api/exports/transactions?type=swaps")
      .set("Authorization", "Bearer rm_test");
    expect(badType.status).toBe(400);

    const badLimit = await request(app)
      .get("/api/exports/transactions?limit=999999")
      .set("Authorization", "Bearer rm_test");
    expect(badLimit.status).toBe(400);
  });

  it("returns 500 when the query fails", async () => {
    (prisma.loanRepayment.findMany as jest.Mock).mockRejectedValue(new Error("db down"));
    jest.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).get("/api/exports/transactions").set("Authorization", "Bearer rm_test");
    expect(res.status).toBe(500);
  });
});
