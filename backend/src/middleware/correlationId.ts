// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import rTracer from "cls-rtracer";

/**
 * Header carrying the correlation ID across service hops.
 *
 * An inbound request may supply its own ID (e.g. an upstream gateway or a
 * calling service that already opened a trace); otherwise one is minted here.
 * The same value is echoed back on the response and forwarded on outgoing
 * webhooks, so a single ID stitches the whole pipeline together.
 */
export const CORRELATION_ID_HEADER = "X-Correlation-Id";

/** Max accepted length of a caller-supplied correlation ID. */
const MAX_ID_LENGTH = 128;
/** Only safe, log-friendly characters survive from an inbound header. */
const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Returns a caller-supplied ID if it is well-formed, otherwise a fresh UUID.
 *
 * Untrusted header values are validated before they reach the logs — an
 * attacker-controlled ID must not be able to inject newlines or unbounded
 * payloads into log lines.
 */
export function normalizeCorrelationId(incoming: unknown): string {
  if (
    typeof incoming === "string" &&
    incoming.length > 0 &&
    incoming.length <= MAX_ID_LENGTH &&
    SAFE_ID_PATTERN.test(incoming)
  ) {
    return incoming;
  }
  return randomUUID();
}

/**
 * Establishes a correlation ID for the lifetime of the request.
 *
 * Runs on a continuation-local storage context, so any code executing inside
 * the request — route handlers, db queries, background awaits — can read the
 * ID without it being threaded through every function signature. The Winston
 * logger picks it up automatically via `rTracer.id()`.
 *
 * Must be registered before any middleware that logs.
 */
export const correlationId: RequestHandler = rTracer.expressMiddleware({
  useHeader: true,
  headerName: CORRELATION_ID_HEADER,
  echoHeader: true,
  requestIdFactory: (req) =>
    normalizeCorrelationId(req?.headers?.[CORRELATION_ID_HEADER.toLowerCase()]),
}) as RequestHandler;

/**
 * Reads the correlation ID of the in-flight request, if any.
 *
 * Returns `undefined` outside a request context (schedulers, startup code),
 * where there is nothing to correlate against.
 */
export function getCorrelationId(): string | undefined {
  const id = rTracer.id();
  return typeof id === "string" ? id : undefined;
}

/**
 * Header bag to merge into an outgoing HTTP request so the downstream hop
 * inherits this request's correlation ID. Empty outside a request context.
 */
export function correlationHeaders(): Record<string, string> {
  const id = getCorrelationId();
  return id ? { [CORRELATION_ID_HEADER]: id } : {};
}
