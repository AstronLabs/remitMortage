// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import winston from "winston";
import rTracer from "cls-rtracer";
import { trace } from "@opentelemetry/api";

const { combine, timestamp, json, colorize, simple, errors, printf } = winston.format;

const isProduction = process.env.NODE_ENV === "production";

/** Adds correlation ID (request tracing) to log metadata */
const requestIdFormat = winston.format((info) => {
  const id = rTracer.id();
  if (id) info.requestId = id;
  
  try {
    const span = trace.getActiveSpan();
    if (span) {
      const spanContext = span.spanContext();
      info.traceId = spanContext.traceId;
      info.spanId = spanContext.spanId;
    }
  } catch (err) {
    // Ignore tracing errors to ensure logging remains resilient
  }
  
  return info;
});

/** Adds runtime environment context to logs */
const environmentFormat = winston.format((info) => {
  info.environment = process.env.NODE_ENV || "development";
  info.service = "remitmortgage-backend";
  return info;
});

/** Human-readable console format for development */
const devFormat = printf(({ level, message, timestamp, requestId, ...meta }) => {
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
  const reqId = requestId ? `[${requestId}]` : "";
  return `${timestamp} ${level} ${reqId}: ${message} ${metaStr}`;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    errors({ stack: true }),
    requestIdFormat(),
    environmentFormat(),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    isProduction ? json() : combine(colorize(), devFormat)
  ),
  defaultMeta: {
    pid: process.pid,
    hostname: process.env.HOSTNAME || "unknown",
  },
  transports: [
    new winston.transports.Console({
      stderrLevels: ["error"],
    }),
  ],
});

/** Structured logging helper for HTTP requests */
export function logHttpRequest(
  method: string,
  path: string,
  statusCode: number,
  durationMs: number,
  metadata: Record<string, unknown> = {}
) {
  logger.info("HTTP Request", {
    method,
    path,
    statusCode,
    durationMs: Number(durationMs.toFixed(2)),
    ...metadata,
  });
}

/** Structured logging helper for errors with full context */
export function logError(
  message: string,
  error: Error,
  context: Record<string, unknown> = {}
) {
  logger.error(message, {
    error: {
      message: error.message,
      name: error.name,
      stack: error.stack,
    },
    ...context,
  });
}

export default logger;

