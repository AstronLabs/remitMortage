// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router, type Request, type Response } from "express";
import { prisma } from "../services/db.js";
import { requireScopedApiKey } from "../middleware/apiKeyAuth.js";
import { exportRateLimiter, recordExportedRows } from "../middleware/exportRateLimit.js";
import { apiKeyQuotaMiddleware } from "../middleware/apiKeyQuota.js";
import { apiKeyRateLimiter } from "../middleware/apiKeyRateLimit.js";
import {
  getLongRunningStatementTimeoutMs,
  isStatementTimeoutError,
  runWithStatementTimeout,
  StatementTimeoutError,
} from "../services/statementTimeout.js";

export const exportsRouter = Router();

const TRANSACTIONS_SCOPE = "export:transactions";
const MAX_PAGE_SIZE = 5000;
export const EXPORT_BATCH_SIZE = 500;

const TRANSACTION_SOURCES = {
  deposits: (client: any) => client.escrowDeposit,
  withdrawals: (client: any) => client.escrowWithdrawal,
  disbursements: (client: any) => client.loanDisbursement,
  repayments: (client: any) => client.loanRepayment,
} as const;

type TransactionType = keyof typeof TRANSACTION_SOURCES;

export interface StreamTransactionExportOptions {
  type: TransactionType;
  fromLedger: number;
  limit: number;
  batchSize?: number;
  shouldAbort?: () => boolean;
  writeChunk: (chunk: string) => void;
  fetchBatch: (args: {
    where: Record<string, unknown>;
    orderBy: Array<Record<string, "asc" | "desc">>;
    take: number;
  }) => Promise<Array<{ id?: string; ledger?: number; [key: string]: unknown }>>;
}

/**
 * Streams a transaction export in bounded batches without buffering the full
 * dataset in memory (#994). Stops querying immediately if `shouldAbort()`
 * becomes true (e.g. client disconnect).
 */
export async function streamBatchedTransactionExport(
  opts: StreamTransactionExportOptions,
): Promise<{ totalRows: number; batchesRead: number; aborted: boolean }> {
  const batchSize = opts.batchSize ?? EXPORT_BATCH_SIZE;
  const shouldAbort = opts.shouldAbort ?? (() => false);

  let remaining = opts.limit;
  let cursor: { ledger: number; id: string } | null = null;
  let totalRows = 0;
  let batchesRead = 0;
  let aborted = false;

  // Read the first batch before writing headers/prefix so any initial database
  // or statement-timeout failure can still return a clean HTTP 500 / 503 status.
  const firstTake = Math.min(remaining, batchSize);
  const firstBatch = await opts.fetchBatch({
    where: { ledger: { gte: opts.fromLedger } },
    orderBy: [{ ledger: "asc" }, { id: "asc" }],
    take: firstTake,
  });
  batchesRead += 1;

  // Single-batch fast path: when all requested rows fit in the first batch,
  // emit the exact `{"type":...,"count":...,"rows":[...]}` structure while
  // streaming row by row.
  const hasMoreBatches =
    firstBatch.length === firstTake && remaining > firstBatch.length;

  if (!hasMoreBatches) {
    opts.writeChunk(
      `{"type":${JSON.stringify(opts.type)},"count":${firstBatch.length},"rows":[`,
    );
    for (let i = 0; i < firstBatch.length; i++) {
      if (shouldAbort()) {
        aborted = true;
        break;
      }
      if (i > 0) opts.writeChunk(",");
      opts.writeChunk(JSON.stringify(firstBatch[i]));
      totalRows += 1;
    }
    opts.writeChunk("]}");
    return { totalRows, batchesRead, aborted };
  }

  // Multi-batch streaming path: stream rows batch by batch, keeping only one
  // batch (`<= batchSize`) resident in memory at a time.
  opts.writeChunk(`{"type":${JSON.stringify(opts.type)},"rows":[`);
  let wroteAny = false;

  let currentBatch = firstBatch;
  while (currentBatch.length > 0 && remaining > 0) {
    for (const row of currentBatch) {
      if (shouldAbort()) {
        aborted = true;
        break;
      }
      if (wroteAny) opts.writeChunk(",");
      opts.writeChunk(JSON.stringify(row));
      wroteAny = true;
      totalRows += 1;
      remaining -= 1;
      if (typeof row.ledger === "number" && typeof row.id === "string") {
        cursor = { ledger: row.ledger, id: row.id };
      }
      if (remaining <= 0) break;
    }

    if (aborted || remaining <= 0 || currentBatch.length < Math.min(remaining + currentBatch.length, batchSize)) {
      break;
    }

    if (shouldAbort()) {
      aborted = true;
      break;
    }

    const nextTake = Math.min(remaining, batchSize);
    const where: Record<string, unknown> = cursor
      ? {
          OR: [
            { ledger: { gt: cursor.ledger } },
            { ledger: cursor.ledger, id: { gt: cursor.id } },
          ],
        }
      : { ledger: { gte: opts.fromLedger } };

    currentBatch = await opts.fetchBatch({
      where,
      orderBy: [{ ledger: "asc" }, { id: "asc" }],
      take: nextTake,
    });
    batchesRead += 1;
  }

  opts.writeChunk(`],"count":${totalRows}}`);
  return { totalRows, batchesRead, aborted };
}

// GET /api/exports/transactions?type=repayments&fromLedger=0&limit=1000
exportsRouter.get(
  "/transactions",
  requireScopedApiKey(TRANSACTIONS_SCOPE),
  // Plan-tiered request rate (issue #1106), checked before the request is
  // metered against the billing-period quota.
  apiKeyRateLimiter(),
  apiKeyQuotaMiddleware(),
  exportRateLimiter(TRANSACTIONS_SCOPE),
  async (req: Request, res: Response) => {
    const type = String(req.query.type ?? "repayments") as TransactionType;
    if (!(type in TRANSACTION_SOURCES)) {
      return res.status(400).json({
        error: "invalid_type",
        message: `type must be one of: ${Object.keys(TRANSACTION_SOURCES).join(", ")}`,
      });
    }

    const fromLedger = parseInt(String(req.query.fromLedger ?? "0"), 10);
    const limit = parseInt(String(req.query.limit ?? "1000"), 10);
    if (
      !Number.isFinite(fromLedger) ||
      fromLedger < 0 ||
      !Number.isFinite(limit) ||
      limit < 1 ||
      limit > MAX_PAGE_SIZE
    ) {
      return res.status(400).json({
        error: "invalid_query",
        message: `fromLedger must be >= 0 and limit must be between 1 and ${MAX_PAGE_SIZE}`,
      });
    }

    const rawBatchSize = req.query.batchSize
      ? parseInt(String(req.query.batchSize), 10)
      : EXPORT_BATCH_SIZE;
    const batchSize =
      Number.isFinite(rawBatchSize) && rawBatchSize >= 1 && rawBatchSize <= EXPORT_BATCH_SIZE
        ? rawBatchSize
        : EXPORT_BATCH_SIZE;

    let clientDisconnected = false;
    const markDisconnected = () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
      }
    };
    req.on("close", markDisconnected);
    res.on("close", markDisconnected);

    // Exports are a legitimately long-running job, so they run with an explicit
    // statement timeout that overrides the interactive default for this
    // transaction only (issue #1034).
    const exportTimeoutMs = getLongRunningStatementTimeoutMs();

    try {
      await runWithStatementTimeout(prisma, exportTimeoutMs, async (tx) => {
        const delegate = TRANSACTION_SOURCES[type](tx) as unknown as {
          findMany: (args: unknown) => Promise<Array<{ id?: string; ledger?: number }>>;
        };

        let headersPrepared = false;
        const prepareHeaders = () => {
          if (headersPrepared) return;
          headersPrepared = true;
          res.status(200);
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="transactions-${type}.json"`,
          );
        };

        const result = await streamBatchedTransactionExport({
          type,
          fromLedger,
          limit,
          batchSize,
          shouldAbort: () => clientDisconnected || res.destroyed || res.writableEnded,
          writeChunk: (chunk) => {
            prepareHeaders();
            if (!clientDisconnected && !res.destroyed && !res.writableEnded) {
              res.write(chunk);
            }
          },
          fetchBatch: (args) => delegate.findMany(args),
        });

        recordExportedRows(res, result.totalRows);
      });

      if (!res.writableEnded) {
        res.end();
      }
      return;
    } catch (error) {
      if (isStatementTimeoutError(error)) {
        const timeout =
          error instanceof StatementTimeoutError
            ? error
            : new StatementTimeoutError(exportTimeoutMs);
        if (!res.headersSent) {
          res.setHeader("Retry-After", "1");
          return res.status(timeout.statusCode).json({
            error: timeout.code,
            message: timeout.message,
            retryable: timeout.retryable,
            statusCode: timeout.statusCode,
          });
        }
        res.end();
        return;
      }
      console.error("Transaction export error:", error);
      if (!res.headersSent) {
        return res.status(500).json({ error: "export_failed" });
      }
      res.end();
      return;
    }
  },
);
