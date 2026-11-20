// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Synthetic request and response examples for every documented operation
 * (issue #986).
 *
 * `swaggerSpec` is generated from the `@openapi` blocks in `src/routes`, then
 * merged with this registry. Keeping the examples in one place makes missing
 * coverage obvious: `src/__tests__/openapiExamples.test.ts` fails when an
 * operation has no entry, when a documented body has no example, and when an
 * example does not validate against the schema that accompanies it.
 *
 * All values are fake. Never put a real key, seed, address or credential here.
 */

export interface OperationExamples {
  /** Body example for the operation's request content (when it takes one). */
  request?: unknown;
  /** Response examples keyed by status code. */
  responses: Record<string, unknown>;
}

const TS = "2026-01-15T10:00:00.000Z";
const ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const UUID = "3f3c2e5e-1d6a-4a0b-9f8e-2c6b6a7d8e90";
const RECIPIENT = "G" + "B".repeat(55);

const err = (statusCode: number, error: string, message: string) => ({
  error,
  message,
  statusCode,
  timestamp: TS,
});

const badRequest = err(400, "invalid_request", "One or more fields are invalid");
const validationError = {
  error: "missing_field",
  field: "senderAddress",
  message: "senderAddress is required",
};
const unauthorized = err(401, "missing_authorization", "Authentication is required");
const forbidden = err(403, "forbidden", "Caller is not permitted to perform this action");
const notFound = err(404, "not_found", "Resource not found");
const serverError = err(500, "internal_error", "Unexpected server error");

const subscription = {
  id: UUID,
  label: "Acme Underwriter",
  url: "https://partner.example.com/hooks",
  topics: ["deposit", "disburse"],
  status: "active",
  ownerAddress: ADDRESS,
  createdAt: TS,
};

const remittanceAnalysis = {
  senderAddress: ADDRESS,
  recipientAddress: RECIPIENT,
  totalPayments: 12,
  totalAmountUSDC: "2400.00",
  averageAmountUSDC: "200.00",
  standardDeviation: 18.4,
  selfDealing: false,
  firstPayment: "2025-02-01T09:00:00.000Z",
  lastPayment: "2026-01-01T09:00:00.000Z",
  spanMonths: 11,
  eligible: true,
  reason: "Consistent monthly remittances over 11 months",
};

const borrowerStatus = {
  address: ADDRESS,
  escrow: {
    deposited: "5000000000",
    target: "7000000000",
    progress: 71.43,
    startLedger: 123456,
    released: false,
    withdrawn: false,
  },
  pool: { availableLiquidity: "250000000000" },
  verificationStatus: "ELIGIBLE",
  creditScore: 78,
  verification: {
    eligible: true,
    totalPayments: 12,
    totalVolume: 2400,
    spanMonths: 11,
    reportHash: "a".repeat(64),
    analyzedAt: TS,
  },
  loan: {
    status: "Disbursing",
    principal: "7000000000",
    disbursed: "5000000000",
    repaid: "1000000000",
    outstanding: "6000000000",
    escrowContractId: "CESCROW000000000000000000000000000000000000000000000000000",
    loanId: "f".repeat(64),
  },
};

const device = {
  deviceId: UUID,
  label: "Laptop",
  fingerprint: "b".repeat(64),
  createdAt: TS,
  lastSeenAt: TS,
  revokedAt: null,
  current: true,
};

export const OPERATION_EXAMPLES: Readonly<Record<string, OperationExamples>> = {
  // ── Webhooks ──────────────────────────────────────────────────────────
  "GET /api/webhooks/subscriptions": {
    responses: { 200: { subscriptions: [subscription] } },
  },
  "POST /api/webhooks/subscriptions": {
    request: {
      label: "Acme Underwriter",
      url: "https://partner.example.com/hooks",
      topics: ["deposit", "disburse"],
      ownerAddress: ADDRESS,
    },
    responses: {
      201: { ...subscription, secret: "whsec_synthetic_example_only" },
      400: badRequest,
      401: unauthorized,
    },
  },
  "GET /api/webhooks/subscriptions/{id}": {
    responses: { 200: subscription, 404: notFound },
  },
  "PATCH /api/webhooks/subscriptions/{id}/status": {
    request: { status: "paused" },
    responses: {
      200: { ...subscription, status: "paused" },
      400: badRequest,
      404: notFound,
    },
  },
  "POST /api/webhooks/subscriptions/{id}/rotate": {
    responses: {
      200: { id: UUID, secret: "whsec_synthetic_rotated", previousSecretExpiresAt: TS },
      404: notFound,
    },
  },
  "POST /api/webhooks/subscriptions/{id}/rotate/confirm": {
    responses: { 200: { id: UUID, secretRotatedAt: TS }, 404: notFound },
  },
  "GET /api/webhooks/subscriptions/{id}/deliveries": {
    responses: {
      200: {
        deliveries: [
          {
            id: UUID,
            eventId: "evt_01",
            outcome: "delivered",
            statusCode: 200,
            attempt: 1,
            latencyMs: 142,
            dispatchedAt: TS,
          },
        ],
      },
      404: notFound,
    },
  },
  "POST /api/webhooks/subscriptions/{id}/replay-window": {
    request: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z", topics: ["deposit"] },
    responses: {
      200: { queued: 4, skipped: 0, from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      400: badRequest,
      403: forbidden,
      429: err(429, "rate_limited", "Too many replay requests"),
    },
  },
  "POST /api/webhooks/deliveries/{deliveryId}/replay": {
    responses: {
      200: { deliveryId: UUID, queued: true },
      400: badRequest,
      404: notFound,
    },
  },
  "POST /api/webhooks/verify": {
    request: {
      secret: "whsec_synthetic_example_only",
      subscriptionId: UUID,
      timestamp: "1768471200",
      rawBody: '{"event":"deposit"}',
      signature: "t=1768471200,v1=abc123",
    },
    responses: { 200: { valid: true }, 400: badRequest },
  },

  // ── Waitlist and proof ────────────────────────────────────────────────
  "POST /api/waitlist": {
    request: { email: "borrower@example.com", walletAddress: ADDRESS },
    responses: {
      201: { id: UUID, email: "borrower@example.com", status: "pending", position: 42, createdAt: TS },
      400: badRequest,
    },
  },
  "POST /api/verify/proof": {
    request: { reportId: UUID },
    responses: {
      200: { valid: true, reportId: UUID, verifiedAt: TS },
      400: badRequest,
      404: notFound,
      500: serverError,
    },
  },

  // ── Verification ──────────────────────────────────────────────────────
  "POST /api/verification/check": {
    request: {
      senderAddress: ADDRESS,
      recipientAddress: RECIPIENT,
    },
    responses: {
      200: { ...remittanceAnalysis, reportId: UUID, generatedAt: TS, reportHash: "c".repeat(64) },
      400: validationError,
      500: serverError,
    },
  },
  "GET /api/verification/report/{reportId}": {
    responses: {
      200: "%PDF-1.7 synthetic verification report",
      404: notFound,
      500: serverError,
    },
  },
  "POST /api/verification/score": {
    request: { senderAddress: ADDRESS, recipientAddress: RECIPIENT },
    responses: {
      200: { score: 78, eligible: true, reasons: ["Consistent monthly remittances"] },
      400: badRequest,
      500: serverError,
    },
  },
  "POST /api/verification/challenge": {
    request: { walletAddress: ADDRESS, network: "stellar" },
    responses: {
      200: { challenge: "remitmortgage:challenge:7c9e6679" },
      400: badRequest,
    },
  },
  "POST /api/verification/verify-ownership": {
    request: {
      walletAddress: ADDRESS,
      network: "stellar",
      challenge: "remitmortgage:challenge:7c9e6679",
      signature: "c2lnbmF0dXJl",
    },
    responses: {
      200: { verified: true, walletAddress: ADDRESS },
      400: badRequest,
      401: unauthorized,
      410: err(410, "challenge_expired", "The challenge has expired"),
    },
  },
  "POST /api/verification/step-up": {
    request: { walletAddress: ADDRESS, network: "stellar", code: "123456" },
    responses: { 200: { verified: true }, 401: unauthorized },
  },

  // ── User account ──────────────────────────────────────────────────────
  "GET /api/user/data-export": {
    responses: {
      200: {
        exportedAt: TS,
        borrower: { walletAddress: ADDRESS, email: "borrower@example.com" },
        loans: [],
        verificationResults: [],
      },
      401: unauthorized,
      500: serverError,
    },
  },
  "POST /api/user/data-deletion": {
    request: { reason: "No longer using the service", confirm: true },
    responses: {
      200: { requestId: UUID, status: "pending", scheduledFor: "2026-02-14T10:00:00.000Z" },
      400: badRequest,
      401: unauthorized,
      500: serverError,
    },
  },
  "GET /api/user/communication-preferences": {
    responses: {
      200: { preferences: [{ category: "DEPOSITS", channel: "EMAIL", enabled: true }] },
      401: unauthorized,
    },
  },
  "PUT /api/user/communication-preferences": {
    request: {
      updates: [{ category: "DEPOSITS", channel: "EMAIL", enabled: false, source: "user" }],
    },
    responses: {
      200: { preferences: [{ category: "DEPOSITS", channel: "EMAIL", enabled: false }] },
      400: badRequest,
      401: unauthorized,
    },
  },

  // ── Tenant and status ─────────────────────────────────────────────────
  "GET /api/tenant/branding": {
    responses: {
      200: {
        tenantId: "acme",
        displayName: "Acme Mortgage",
        primaryColor: "#1f6feb",
        logoUrl: "https://cdn.example.com/acme/logo.png",
      },
    },
  },
  "GET /api/status": {
    responses: {
      200: { status: "operational", updatedAt: TS, components: { database: "operational", rpc: "operational" } },
      503: { status: "degraded", updatedAt: TS, components: { database: "operational", rpc: "degraded" } },
    },
  },
  "GET /api/health/rpc": {
    responses: {
      200: { status: "healthy", latencyMs: 38, latestLedger: 1234567 },
      503: { status: "unhealthy", latencyMs: 5000, error: "RPC request timed out" },
    },
  },

  // ── Milestones and IPFS ───────────────────────────────────────────────
  "POST /api/milestone/upload": {
    request: { file: "(binary upload)", address: ADDRESS, challenge: "remitmortgage:challenge:7c9e6679", signature: "c2lnbmF0dXJl" },
    responses: {
      201: { cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", ipfsUrl: "https://ipfs.example.com/ipfs/bafybei", size: 20480 },
      400: badRequest,
      401: unauthorized,
      413: err(413, "payload_too_large", "Uploaded file exceeds the size limit"),
      500: serverError,
    },
  },
  "DELETE /api/milestone/unpin/{cid}": {
    responses: {
      200: { cid: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", unpinned: true },
      500: serverError,
    },
  },
  "POST /api/milestone/proposals": {
    responses: { 200: { proposalId: UUID, status: "pending", createdAt: TS } },
  },
  "POST /api/milestone/proposals/{id}/reject": {
    responses: { 200: { proposalId: UUID, status: "rejected", rejectedAt: TS } },
  },

  // ── Metrics ───────────────────────────────────────────────────────────
  "GET /metrics": {
    responses: {
      200: "# HELP remitmortgage_http_requests_total Total HTTP requests.\nremitmortgage_http_requests_total{method=\"GET\",route=\"/api/health\",status_code=\"200\"} 12\n",
      401: unauthorized,
    },
  },

  // ── KYC ───────────────────────────────────────────────────────────────
  "POST /api/kyc/{address}/upload": {
    request: { document: "(binary upload)" },
    responses: {
      201: { documentId: UUID, uploadedAt: TS, scanStatus: "clean", ocr: { ocrFailed: false } },
      400: badRequest,
      403: forbidden,
    },
  },
  "POST /api/kyc/{documentId}/confirm": {
    request: { confirmName: true, confirmIdNumber: true, confirmAddress: true },
    responses: {
      200: { documentId: UUID, confirmed: true, confirmedAt: TS },
      400: badRequest,
      403: forbidden,
      404: notFound,
    },
  },
  "POST /api/kyc/{documentId}/submit": {
    responses: {
      200: { documentId: UUID, status: "submitted", submittedAt: TS },
      400: badRequest,
      403: forbidden,
      404: notFound,
    },
  },
  "GET /api/kyc/{documentId}/ocr": {
    responses: {
      200: { documentId: UUID, ocrFailed: false, text: "Name: Jane Doe" },
      403: forbidden,
      404: notFound,
    },
  },
  "POST /api/kyc/access-token": {
    responses: { 200: { token: "synthetic-access-token", expiresAt: TS }, 401: unauthorized, 404: notFound },
  },
  "GET /api/kyc/{documentId}/decrypt": {
    responses: {
      200: { documentId: UUID, contentBase64: "JVBERi0xLjQK" },
      401: unauthorized,
      404: notFound,
    },
  },
  "GET /api/kyc/{address}/employment-verification": {
    responses: {
      200: { employerName: "Acme Corp", verified: true, verifiedAt: TS },
      403: forbidden,
    },
  },
  "POST /api/kyc/{address}/employment-verification": {
    request: { employerName: "Acme Corp" },
    responses: {
      200: { employerName: "Acme Corp", verified: true, verifiedAt: TS },
      400: badRequest,
      403: forbidden,
    },
  },

  // ── Incident webhooks ─────────────────────────────────────────────────
  "POST /api/webhooks/pagerduty": {
    request: { event: "incident.triggered", payload: { id: "P123", urgency: "high" } },
    responses: { 200: { received: true }, 400: badRequest, 500: serverError },
  },

  // ── Impersonation ─────────────────────────────────────────────────────
  "POST /api/admin/impersonate/start": {
    responses: { 200: { impersonationId: UUID, expiresAt: TS, readOnly: true } },
  },
  "POST /api/admin/impersonate/end": {
    responses: { 200: { ended: true } },
  },
  "GET /api/admin/impersonate/status": {
    responses: { 200: { active: false, expiresAt: null } },
  },

  // ── Health ────────────────────────────────────────────────────────────
  "GET /api/health": {
    responses: {
      200: {
        status: "ok",
        service: "remitmortgage-api",
        timestamp: TS,
        components: {
          database: { status: "healthy", latencyMs: 3 },
          horizon: { status: "healthy", latencyMs: 41 },
        },
      },
      503: {
        status: "degraded",
        service: "remitmortgage-api",
        timestamp: TS,
        components: {
          database: { status: "healthy", latencyMs: 3 },
          horizon: { status: "unhealthy", latencyMs: 5000, error: "Horizon request timed out" },
        },
      },
    },
  },
  "GET /api/health/live": {
    responses: { 200: { status: "ok" } },
  },
  "GET /api/health/ready": {
    responses: { 200: { status: "ready" }, 503: { status: "not_ready" } },
  },

  // ── Email events ──────────────────────────────────────────────────────
  "POST /api/webhooks/email-events": {
    request: [{ event: "delivered", messageId: "msg_01", email: "borrower@example.com" }],
    responses: {
      200: { received: 1, processed: 1 },
      400: badRequest,
      401: unauthorized,
    },
  },

  // ── Borrower ──────────────────────────────────────────────────────────
  "GET /api/borrower/{address}/status": {
    responses: {
      200: borrowerStatus,
      400: validationError,
      401: unauthorized,
      403: forbidden,
      500: serverError,
      502: err(502, "horizon_unavailable", "Horizon is unreachable"),
    },
  },

  // ── Auth ──────────────────────────────────────────────────────────────
  "POST /api/auth/register": {
    request: { walletAddress: ADDRESS, email: "borrower@example.com", inviteCode: "INVITE-2026" },
    responses: {
      201: { userId: UUID, walletAddress: ADDRESS, token: "synthetic-jwt" },
      400: badRequest,
      403: forbidden,
    },
  },

  // ── Audit log ─────────────────────────────────────────────────────────
  "GET /api/audit-logs": {
    responses: {
      200: {
        logs: [{ id: UUID, action: "loan.approved", actor: ADDRESS, createdAt: TS }],
        nextCursor: null,
      },
      401: unauthorized,
      403: forbidden,
      500: serverError,
    },
  },

  // ── Analytics ─────────────────────────────────────────────────────────
  "GET /api/analytics/overview": {
    responses: {
      200: {
        tvl: { escrow: "500000000000", lendingPool: "1320000000000", total: "1820000000000" },
        totalBorrowers: 250,
        totalInvestors: 48,
        totalLoans: 128,
      },
    },
  },
  "GET /api/analytics/loans": {
    responses: { 200: { items: [{ status: "ACTIVE", count: 74 }], updatedAt: TS } },
  },
  "GET /api/analytics/disbursement": {
    responses: { 200: { points: [{ date: "2026-01-14", amount: "12500000000" }] } },
  },
  "GET /api/analytics/volume": {
    responses: { 200: { points: [{ date: "2026-01-14", amount: "86000000000" }] } },
  },
  "GET /api/analytics/pool-rates": {
    responses: {
      200: { rates: [{ pool: "USDC", apr: 0.0875 }] },
      502: err(502, "pool_unavailable", "Pool rate provider is unavailable"),
      503: err(503, "service_unavailable", "Analytics is temporarily unavailable"),
    },
  },
  "GET /api/analytics/gas": {
    responses: { 200: { averageGas: 1420, updatedAt: TS } },
  },
  "GET /api/analytics/rate-benchmark": {
    responses: {
      200: { benchmarkRate: 0.0725, source: "synthetic-benchmark" },
      503: err(503, "benchmark_unavailable", "Rate benchmark is unavailable"),
    },
  },

  // ── Admin search and latency ──────────────────────────────────────────
  "GET /api/admin/search": {
    responses: {
      200: {
        results: [{ type: "loan", id: UUID, title: "Loan application", snippet: "Applicant Sm***" }],
        page: 1,
        pageSize: 20,
        total: 1,
      },
      400: badRequest,
      403: forbidden,
    },
  },
  "GET /api/admin/latency-budget-violations": {
    responses: {
      200: {
        generatedAt: TS,
        defaultBudgetMs: 500,
        routes: [
          {
            method: "GET",
            route: "/api/audit-logs",
            budgetMs: 1000,
            requests: 40,
            exceeded: 6,
            exceededRatio: 0.15,
            maxDurationMs: 1840,
            lastExceededAt: TS,
          },
        ],
      },
      401: unauthorized,
      403: forbidden,
    },
  },

  // ── Admin devices ─────────────────────────────────────────────────────
  "POST /api/admin/devices/enroll": {
    request: { publicKey: "c3ludGhldGljLXB1YmxpYy1rZXk=", label: "Laptop" },
    responses: {
      201: {
        deviceId: UUID,
        fingerprint: "b".repeat(64),
        label: "Laptop",
        createdAt: TS,
        mode: "enforce",
        bound: true,
      },
      400: badRequest,
      401: unauthorized,
    },
  },
  "GET /api/admin/devices": {
    responses: {
      200: { mode: "enforce", boundFingerprint: "b".repeat(64), devices: [device] },
      401: unauthorized,
    },
  },
  "POST /api/admin/devices/{deviceId}/revoke": {
    responses: {
      200: { deviceId: UUID, label: "Laptop", revokedAt: TS, revokedReason: "lost device" },
      401: unauthorized,
      404: notFound,
    },
  },

  // ── Admin 2FA ─────────────────────────────────────────────────────────
  "GET /api/admin/2fa/status": {
    responses: { 200: { enabled: false, recoveryCodesRemaining: 0 } },
  },
  "POST /api/admin/2fa/setup": {
    responses: { 200: { otpauthUrl: "otpauth://totp/RemitMortgage:admin?secret=JBSWY3DPEHPK3PXP", qrCodeDataUrl: "data:image/png;base64,iVBORw0KGgo=" } },
  },
  "POST /api/admin/2fa/enable": {
    responses: { 200: { enabled: true, recoveryCodes: ["abcde-12345", "fghij-67890"] } },
  },
  "POST /api/admin/2fa/verify": {
    responses: { 200: { verified: true } },
  },
  "POST /api/admin/2fa/recovery-codes/regenerate": {
    responses: { 200: { recoveryCodes: ["abcde-12345", "fghij-67890"] } },
  },
  "POST /api/admin/2fa/disable": {
    responses: { 200: { enabled: false } },
  },

  // ── Admin operations ──────────────────────────────────────────────────
  "POST /api/admin/loans/bulk-review": {
    responses: {
      200: { processed: 2, failed: 0, results: [{ id: UUID, status: "APPROVED" }], failures: [] },
      400: badRequest,
      403: forbidden,
      500: serverError,
    },
  },
  "POST /api/admin/applicants/merge": {
    responses: { 200: { mergedApplicantId: UUID, mergedCount: 2 } },
  },
  "GET /api/admin/webhooks/latency": {
    responses: {
      200: {
        slaMs: 1000,
        windowMinutes: 30,
        subscriptions: [{ subscriptionId: UUID, attempts: 20, p95Ms: 420, breaches: 1 }],
      },
      400: badRequest,
    },
  },
  "POST /api/admin/escrow/reconcile": {
    responses: {
      200: { reconciled: true, checked: 5, mismatches: 0 },
      500: serverError,
    },
  },
  "POST /api/admin/waitlist/promote": {
    request: { count: 3 },
    responses: { 200: { promoted: 3 }, 400: badRequest },
  },
  "GET /api/admin/scoring/models": {
    responses: {
      200: { activeVersion: "v3", shadowVersion: "v4", shadowModeEnabled: true },
    },
  },
  "POST /api/admin/scoring/models": {
    responses: {
      200: { activeVersion: "v3", shadowVersion: "v4", shadowModeEnabled: true },
    },
  },
};

// ---------------------------------------------------------------------------
// Applying and checking coverage
// ---------------------------------------------------------------------------

export interface LooseMediaType {
  schema?: Record<string, unknown> & { $ref?: string };
  example?: unknown;
  [key: string]: unknown;
}

export interface LooseResponse {
  description?: string;
  content?: Record<string, LooseMediaType>;
  [key: string]: unknown;
}

export interface LooseOperation {
  requestBody?: { content?: Record<string, LooseMediaType>; [key: string]: unknown };
  responses?: Record<string, LooseResponse>;
  [key: string]: unknown;
}

export interface LooseSpec {
  paths?: Record<string, Record<string, LooseOperation | undefined> | undefined>;
  [key: string]: unknown;
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

export interface OperationRef {
  method: string;
  path: string;
  key: string;
  operation: LooseOperation;
}

/** Every path/method pair in the document. */
export function listOperations(spec: LooseSpec): OperationRef[] {
  const operations: OperationRef[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const operation = pathItem?.[method];
      if (operation) {
        operations.push({ method, path, key: `${method.toUpperCase()} ${path}`, operation });
      }
    }
  }
  return operations;
}

function applyToMedia(
  content: Record<string, LooseMediaType>,
  example: unknown,
  onlyExisting = false
): void {
  const entries = Object.entries(content);
  if (entries.length === 0 && !onlyExisting) {
    content["application/json"] = { example };
    return;
  }
  // Prefer the JSON representation: non-JSON siblings (e.g. a PDF stream)
  // have different schemas and would reject an object example.
  if (content["application/json"]) {
    content["application/json"].example = example;
    return;
  }
  for (const [, media] of entries) media.example = example;
}

/**
 * Merges the registry into a generated document. Operations without explicit
 * responses get a documented 200 so the example has somewhere to live.
 */
export function applyOperationExamples(
  spec: LooseSpec,
  examples: Readonly<Record<string, OperationExamples>>
): LooseSpec {
  for (const { key, operation } of listOperations(spec)) {
    const entry = examples[key];
    if (!entry) continue;

    if (entry.request !== undefined) {
      operation.requestBody ??= {};
      operation.requestBody.content ??= {};
      applyToMedia(operation.requestBody.content, entry.request);
    }

    operation.responses ??= {};
    if (Object.keys(operation.responses).length === 0) {
      operation.responses["200"] = { description: "Successful response" };
    }

    for (const [status, example] of Object.entries(entry.responses)) {
      const response = (operation.responses[status] ??= { description: "Example response" });
      response.content ??= {};
      applyToMedia(response.content, example);
    }
  }
  return spec;
}

/**
 * Everything that stops the document meeting the example requirements. An
 * empty array means every operation is covered and every documented body has
 * an example.
 */
export function collectOperationExampleIssues(
  spec: LooseSpec,
  examples: Readonly<Record<string, OperationExamples>>
): string[] {
  const issues: string[] = [];

  for (const { key, operation } of listOperations(spec)) {
    const entry = examples[key];
    if (!entry) {
      issues.push(`${key}: no example registered`);
      continue;
    }

    const requestMedia = operation.requestBody?.content;
    if (requestMedia && Object.keys(requestMedia).length > 0) {
      if (entry.request === undefined) issues.push(`${key}: request body has no example`);
      for (const [type, media] of Object.entries(requestMedia)) {
        if (media.example === undefined) issues.push(`${key}: ${type} request has no example`);
      }
    }

    const responses = operation.responses ?? {};
    if (Object.keys(responses).length === 0) {
      issues.push(`${key}: no response examples`);
      continue;
    }
    for (const [status, response] of Object.entries(responses)) {
      const content = response.content ?? {};
      if (Object.keys(content).length === 0) {
        issues.push(`${key} ${status}: response has no example`);
        continue;
      }
      const mediaEntries = Object.entries(content);
      const required = content["application/json"] ? [["application/json", content["application/json"]] as const] : mediaEntries;
      for (const [type, media] of required) {
        if (media.example === undefined) {
          issues.push(`${key} ${status}: ${type} response has no example`);
        }
      }
    }
  }

  return issues;
}
