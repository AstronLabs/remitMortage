// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export interface ErrorCodeEntry {
  code: string;
  httpStatus: number;
  description: string;
  remediation: string;
  retryable?: boolean;
}

export const ERROR_CODE_CATALOG: readonly ErrorCodeEntry[] = Object.freeze([
  {
    code: "BAD_REQUEST",
    httpStatus: 400,
    description: "The request payload or query parameters are malformed.",
    remediation: "Check the request schema and retry with valid parameters.",
  },
  {
    code: "VALIDATION_ERROR",
    httpStatus: 400,
    description: "One or more request fields failed input validation.",
    remediation: "Correct the invalid fields and resubmit the request.",
  },
  {
    code: "INVALID_STATUS_TRANSITION",
    httpStatus: 409,
    description: "The requested state transition is not permitted from the current status.",
    remediation: "Read the current resource status and apply only an allowed transition.",
  },
  {
    code: "UNAUTHORIZED",
    httpStatus: 401,
    description: "Authentication credentials are missing, invalid, or expired.",
    remediation: "Sign in again to obtain a fresh session token.",
  },
  {
    code: "SESSION_REVOKED",
    httpStatus: 401,
    description: "The session token has been revoked by the user or an administrator.",
    remediation: "Re-authenticate to start a new session.",
  },
  {
    code: "FORBIDDEN",
    httpStatus: 403,
    description: "The authenticated caller does not have permission for this resource.",
    remediation: "Verify account permissions or request access from an administrator.",
  },
  {
    code: "NOT_FOUND",
    httpStatus: 404,
    description: "The requested resource does not exist.",
    remediation: "Verify the resource identifier and try again.",
  },
  {
    code: "SESSION_NOT_FOUND",
    httpStatus: 404,
    description: "The specified user session was not found.",
    remediation: "List active sessions via GET /api/sessions to obtain a valid session ID.",
  },
  {
    code: "DSAR_NOT_FOUND",
    httpStatus: 404,
    description: "The specified Data Subject Access Request was not found.",
    remediation: "List requests via GET /api/admin/dsar to obtain a valid request ID.",
  },
  {
    code: "CONFLICT",
    httpStatus: 409,
    description: "The request conflicts with the current state of the resource.",
    remediation: "Refresh the resource state and retry if still applicable.",
  },
  {
    code: "RATE_LIMIT_EXCEEDED",
    httpStatus: 429,
    description: "Too many requests were sent within the rate limit window.",
    remediation: "Wait for the Retry-After window before sending additional requests.",
    retryable: true,
  },
  {
    code: "STATEMENT_TIMEOUT",
    httpStatus: 503,
    description: "The database query exceeded the configured statement timeout.",
    remediation: "Retry the request after a short backoff.",
    retryable: true,
  },
  {
    code: "INTERNAL_ERROR",
    httpStatus: 500,
    description: "An unexpected internal server error occurred.",
    remediation: "Retry the request later or contact support with the request correlation ID.",
    retryable: true,
  },
]);

const CATALOG_BY_CODE = new Map<string, ErrorCodeEntry>(
  ERROR_CODE_CATALOG.map((entry) => [entry.code, entry])
);

export function getErrorCatalog(): readonly ErrorCodeEntry[] {
  return ERROR_CODE_CATALOG;
}

export function lookupErrorCode(code: string): ErrorCodeEntry | undefined {
  return CATALOG_BY_CODE.get(code);
}

export function isRegisteredErrorCode(code: string): boolean {
  return CATALOG_BY_CODE.has(code);
}

export function assertRegisteredErrorCode(code: string): ErrorCodeEntry {
  const entry = CATALOG_BY_CODE.get(code);
  if (!entry) {
    throw new Error(
      `Unregistered API error code "${code}". Register it in backend/src/errors/catalog.ts.`
    );
  }
  return entry;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly remediation: string;
  readonly retryable: boolean;

  constructor(code: string, message?: string, statusCodeOverride?: number) {
    const entry = assertRegisteredErrorCode(code);
    super(message ?? entry.description);
    this.name = "AppError";
    this.code = entry.code;
    this.statusCode = statusCodeOverride ?? entry.httpStatus;
    this.remediation = entry.remediation;
    this.retryable = Boolean(entry.retryable);
  }
}

function defaultCodeForStatus(statusCode: number): string {
  if (statusCode === 400) return "BAD_REQUEST";
  if (statusCode === 401) return "UNAUTHORIZED";
  if (statusCode === 403) return "FORBIDDEN";
  if (statusCode === 404) return "NOT_FOUND";
  if (statusCode === 409) return "CONFLICT";
  if (statusCode === 429) return "RATE_LIMIT_EXCEEDED";
  if (statusCode === 503) return "STATEMENT_TIMEOUT";
  return "INTERNAL_ERROR";
}

export interface ResolvedErrorPayload {
  statusCode: number;
  code: string;
  message: string;
  remediation: string;
  retryable: boolean;
}

export function resolveErrorResponse(err: unknown): ResolvedErrorPayload {
  const e = err as { code?: unknown; statusCode?: unknown; message?: unknown } | null | undefined;
  const rawCode = typeof e?.code === "string" ? e.code : undefined;

  let entry: ErrorCodeEntry | undefined;
  if (rawCode) {
    entry = lookupErrorCode(rawCode);
  }

  if (!entry) {
    const status = typeof e?.statusCode === "number" ? e.statusCode : 500;
    entry = assertRegisteredErrorCode(defaultCodeForStatus(status));
  }

  const statusCode = typeof e?.statusCode === "number" ? e.statusCode : entry.httpStatus;
  const message =
    typeof e?.message === "string" && e.message.length > 0 ? e.message : entry.description;

  return {
    statusCode,
    code: entry.code,
    message,
    remediation: entry.remediation,
    retryable: Boolean(entry.retryable),
  };
}
