// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger.js";
import {
  isStatementTimeoutError,
  StatementTimeoutError,
} from "../services/statementTimeout.js";

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
  // A statement cancelled by the database statement timeout is transient, not a
  // server fault: surface it as a clear, retryable response instead of a 500.
  if (isStatementTimeoutError(err)) {
    const timeout = new StatementTimeoutError();
    logger.warn("Request cancelled by database statement timeout", {
      statusCode: timeout.statusCode,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      retryable: timeout.retryable,
    });

    res.setHeader("Retry-After", "1");
    return res.status(timeout.statusCode).json({
      error: timeout.code,
      message: timeout.message,
      retryable: timeout.retryable,
      statusCode: timeout.statusCode,
      timestamp: new Date().toISOString(),
    });
  }

  const statusCode = err?.statusCode || 500;
  const message = err?.message || "Internal Server Error";

  logger.error(message, {
    statusCode,
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip,
    stack: err?.stack,
  });

  res.status(statusCode).json({ error: message, statusCode, timestamp: new Date().toISOString() });
}
