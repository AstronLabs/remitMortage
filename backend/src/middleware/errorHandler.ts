// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Request, Response, NextFunction } from "express";
import logger from "../utils/logger.js";
import {
  isStatementTimeoutError,
  StatementTimeoutError,
} from "../services/statementTimeout.js";
import { resolveErrorResponse } from "../errors/catalog.js";

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  // A statement cancelled by the database statement timeout is transient, not a
  // server fault: surface it as a clear, retryable response instead of a 500.
  if (isStatementTimeoutError(err)) {
    const timeout = new StatementTimeoutError();
    const resolved = resolveErrorResponse({
      code: "STATEMENT_TIMEOUT",
      statusCode: timeout.statusCode,
      message: timeout.message,
    });
    logger.warn("Request cancelled by database statement timeout", {
      code: resolved.code,
      statusCode: resolved.statusCode,
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      retryable: resolved.retryable,
    });

    res.setHeader("Retry-After", "1");
    return res.status(resolved.statusCode).json({
      error: resolved.code,
      code: resolved.code,
      message: resolved.message,
      remediation: resolved.remediation,
      retryable: resolved.retryable,
      statusCode: resolved.statusCode,
      timestamp: new Date().toISOString(),
    });
  }

  const resolved = resolveErrorResponse(err);

  logger.error(resolved.message, {
    code: resolved.code,
    statusCode: resolved.statusCode,
    method: req.method,
    path: req.originalUrl || req.url,
    ip: req.ip,
    stack: err?.stack,
  });

  res.status(resolved.statusCode).json({
    error: resolved.code,
    code: resolved.code,
    message: resolved.message,
    remediation: resolved.remediation,
    retryable: resolved.retryable,
    statusCode: resolved.statusCode,
    timestamp: new Date().toISOString(),
  });
}
