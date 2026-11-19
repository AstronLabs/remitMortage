// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Router } from "express";
import { prisma } from "../services/db.js";
import { requireScopedApiKey } from "../middleware/apiKeyAuth.js";
import { exportRateLimiter, recordExportedRows } from "../middleware/exportRateLimit.js";
import { apiKeyQuotaMiddleware } from "../middleware/apiKeyQuota.js";
import {
  getLongRunningStatementTimeoutMs,
  isStatementTimeoutError,
  runWithStatementTimeout,
  StatementTimeoutError,
} from "../services/statementTimeout.js";

export const exportsRouter = Router();

const TRANSACTIONS_SCOPE = "export:transactions";
const MAX_PAGE_SIZE = 5000;

const TRANSACTION_SOURCES = {
  deposits: (client: any) => client.escrowDeposit,
  withdrawals: (client: any) => client.escrowWithdrawal,
  disbursements: (client: any) => client.loanDisbursement,
  repayments: (client: any) => client.loanRepayment,
} as const;

type TransactionType = keyof typeof TRANSACTION_SOURCES;

// GET /api/exports/transactions?type=repayments&fromLedger=0&limit=1000
exportsRouter.get(
  "/transactions",
  requireScopedApiKey(TRANSACTIONS_SCOPE),
  apiKeyQuotaMiddleware(),
  exportRateLimiter(TRANSACTIONS_SCOPE),
  async (req, res) => {
    const type = String(req.query.type ?? "repayments") as TransactionType;
    if (!(type in TRANSACTION_SOURCES)) {
      return res.status(400).json({
        error: "invalid_type",
        message: `type must be one of: ${Object.keys(TRANSACTION_SOURCES).join(", ")}`,
      });
    }

    const fromLedger = parseInt(String(req.query.fromLedger ?? "0"), 10);
    const limit = parseInt(String(req.query.limit ?? "1000"), 10);
    if (!Number.isFinite(fromLedger) || fromLedger < 0 || !Number.isFinite(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return res.status(400).json({
        error: "invalid_query",
        message: `fromLedger must be >= 0 and limit must be between 1 and ${MAX_PAGE_SIZE}`,
      });
    }

    // Exports are a legitimately long-running job, so they run with an explicit
    // statement timeout that overrides the interactive default for this
    // transaction only (issue #1034).
    const exportTimeoutMs = getLongRunningStatementTimeoutMs();

    try {
      const rows = await runWithStatementTimeout(
        prisma,
        exportTimeoutMs,
        async (tx) => {
          const delegate = TRANSACTION_SOURCES[type](tx) as unknown as {
            findMany: (args: unknown) => Promise<unknown[]>;
          };
          return delegate.findMany({
            where: { ledger: { gte: fromLedger } },
            orderBy: [{ ledger: "asc" }, { id: "asc" }],
            take: limit,
          });
        },
      );
      recordExportedRows(res, rows.length);
      return res.json({ type, count: rows.length, rows });
    } catch (error) {
      if (isStatementTimeoutError(error)) {
        const timeout =
          error instanceof StatementTimeoutError
            ? error
            : new StatementTimeoutError(exportTimeoutMs);
        res.setHeader("Retry-After", "1");
        return res.status(timeout.statusCode).json({
          error: timeout.code,
          message: timeout.message,
          retryable: timeout.retryable,
          statusCode: timeout.statusCode,
        });
      }
      console.error("Transaction export error:", error);
      return res.status(500).json({ error: "export_failed" });
    }
  },
);
