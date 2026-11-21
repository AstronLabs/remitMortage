// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js", () => {
  const prisma: any = {
    apiKey: { findUnique: jest.fn() },
    escrowDeposit: { findMany: jest.fn() },
    escrowWithdrawal: { findMany: jest.fn() },
    loanDisbursement: { findMany: jest.fn() },
    loanRepayment: { findMany: jest.fn() },
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
  };
  // Interactive transactions run inline against the same double so the models
  // stay directly assertable.
  prisma.$transaction = (fn: (tx: any) => Promise<unknown>) => fn(prisma);
  return { prisma };
});

import express from "express";
import request from "supertest";
import { prisma } from "../services/db.js";
import {
  EXPORT_BATCH_SIZE,
  exportsRouter,
  streamBatchedTransactionExport,
} from "../routes/exports";
import {
  DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS,
  STATEMENT_TIMEOUT_SQLSTATE,
} from "../services/statementTimeout.js";

const app = express();
app.use("/api/exports", exportsRouter);

const validKey = { id: "key-1", key: "rm_test", scopes: ["export:transactions"], revoked: false };

describe("GET /api/exports/transactions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue(validKey);
    (prisma as any).$executeRawUnsafe.mockResolvedValue(0);
  });

  it("requires an API key with the export:transactions scope", async () => {
    expect((await request(app).get("/api/exports/transactions")).status).toBe(401);

    (prisma.apiKey.findUnique as jest.Mock).mockResolvedValue({ ...validKey, scopes: ["read:loans"] });
    const res = await request(app).get("/api/exports/transactions").set("Authorization", "Bearer rm_test");
    expect(res.status).toBe(403);
  });

  it("returns the requested transaction rows ordered by ledger with Content-Disposition attachment", async () => {
    const rows = [{ id: "r1", ledger: 10 }, { id: "r2", ledger: 11 }];
    (prisma.escrowDeposit.findMany as jest.Mock).mockResolvedValue(rows);

    const res = await request(app)
      .get("/api/exports/transactions?type=deposits&fromLedger=10&limit=2")
      .set("Authorization", "Bearer rm_test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "deposits", count: 2, rows });
    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="transactions-deposits.json"'
    );
    expect(prisma.escrowDeposit.findMany).toHaveBeenCalledWith({
      where: { ledger: { gte: 10 } },
      orderBy: [{ ledger: "asc" }, { id: "asc" }],
      take: 2,
    });
    expect(res.headers["x-export-quota-limit"]).toBeDefined();
  });

  it("streams multi-batch exports with output matching the expected format", async () => {
    const batch1 = [
      { id: "r1", ledger: 10, amount: "100" },
      { id: "r2", ledger: 11, amount: "200" },
    ];
    const batch2 = [
      { id: "r3", ledger: 12, amount: "300" },
      { id: "r4", ledger: 13, amount: "400" },
    ];
    const batch3 = [{ id: "r5", ledger: 14, amount: "500" }];

    (prisma.escrowDeposit.findMany as jest.Mock)
      .mockResolvedValueOnce(batch1)
      .mockResolvedValueOnce(batch2)
      .mockResolvedValueOnce(batch3);

    const res = await request(app)
      .get("/api/exports/transactions?type=deposits&fromLedger=10&limit=5&batchSize=2")
      .set("Authorization", "Bearer rm_test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      type: "deposits",
      count: 5,
      rows: [...batch1, ...batch2, ...batch3],
    });
    expect(prisma.escrowDeposit.findMany).toHaveBeenCalledTimes(3);
  });

  it("stops querying further batches when the client disconnects mid-export", async () => {
    let disconnected = false;
    const fetchBatch = jest.fn(async ({ take }: { take: number }) =>
      Array.from({ length: take }, (_, i) => ({
        id: `row-${i}`,
        ledger: 100 + i,
      }))
    );

    let chunksWritten = 0;
    const result = await streamBatchedTransactionExport({
      type: "repayments",
      fromLedger: 100,
      limit: 2000,
      batchSize: 100,
      shouldAbort: () => disconnected,
      writeChunk: () => {
        chunksWritten += 1;
        if (chunksWritten >= 150) {
          disconnected = true;
        }
      },
      fetchBatch,
    });

    expect(result.aborted).toBe(true);
    // Must stop after the first batch instead of reading all 20 batches (2,000 rows).
    expect(fetchBatch).toHaveBeenCalledTimes(1);
    expect(result.totalRows).toBeLessThan(100);
  });

  it("streams a large synthetic table (25,000 rows) in bounded batches without growing peak memory", async () => {
    const TOTAL_ROWS = 25_000;
    let nextId = 0;

    if (typeof global.gc === "function") {
      global.gc();
    }
    const baselineHeap = process.memoryUsage().heapUsed;
    let peakBatchRetainedBytes = 0;
    let totalBytesStreamed = 0;

    const result = await streamBatchedTransactionExport({
      type: "repayments",
      fromLedger: 1,
      limit: TOTAL_ROWS,
      batchSize: EXPORT_BATCH_SIZE,
      // Consumer writes directly to socket and discards the chunk buffer immediately.
      writeChunk: (chunk) => {
        totalBytesStreamed += Buffer.byteLength(chunk, "utf8");
      },
      fetchBatch: async ({ take }) => {
        const remaining = TOTAL_ROWS - nextId;
        const count = Math.min(take, Math.max(0, remaining));
        const batch = Array.from({ length: count }, () => {
          nextId += 1;
          return {
            id: `repay-${nextId}`,
            ledger: 1_000_000 + nextId,
            borrower: "GBORROWERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            amount: "1250000000",
            note: "x".repeat(256),
          };
        });
        const delta = process.memoryUsage().heapUsed - baselineHeap;
        if (delta > peakBatchRetainedBytes) {
          peakBatchRetainedBytes = delta;
        }
        return batch;
      },
    });

    expect(result.totalRows).toBe(TOTAL_ROWS);
    expect(result.batchesRead).toBe(TOTAL_ROWS / EXPORT_BATCH_SIZE);
    expect(totalBytesStreamed).toBeGreaterThan(TOTAL_ROWS * 300);
    // Peak heap delta stays well under 35 MB even when streaming ~9 MB of raw JSON rows.
    expect(peakBatchRetainedBytes).toBeLessThan(35 * 1024 * 1024);
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

  it("runs the export under the explicit long-running statement timeout", async () => {
    (prisma.escrowDeposit.findMany as jest.Mock).mockResolvedValue([]);

    await request(app)
      .get("/api/exports/transactions?type=deposits")
      .set("Authorization", "Bearer rm_test");

    expect((prisma as any).$executeRawUnsafe).toHaveBeenCalledWith(
      `SET LOCAL statement_timeout = ${DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS}`
    );
  });

  it("returns a retryable 503 when the export query is cut off by the timeout", async () => {
    (prisma.escrowDeposit.findMany as jest.Mock).mockRejectedValue(
      Object.assign(new Error("canceling statement due to statement timeout"), {
        code: STATEMENT_TIMEOUT_SQLSTATE,
      })
    );

    const res = await request(app)
      .get("/api/exports/transactions?type=deposits")
      .set("Authorization", "Bearer rm_test");

    expect(res.status).toBe(503);
    expect(res.body.retryable).toBe(true);
    expect(res.headers["retry-after"]).toBe("1");
  });
});
