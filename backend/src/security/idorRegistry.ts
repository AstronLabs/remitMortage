// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Canonical inventory of every API endpoint that accepts a resource identifier
 * (loan ID, applicant ID, document ID, borrower address, …) as a
 * path / query / body parameter (issue #760).
 *
 * Each entry MUST name the ownership check that enforces that the requesting
 * user is authorized for the specific resource ID they supplied. The automated
 * suite in `src/__tests__/idorAudit.test.ts` and the CI gate in
 * `scripts/check-idor-coverage.mjs` both read this registry:
 * adding a new ID-accepting endpoint without registering it (with a test)
 * fails CI.
 */

export interface IdorEndpointEntry {
  /** HTTP method, e.g. "GET". */
  method: string;
  /** Express-style route pattern, e.g. "GET /api/loan/:id". */
  route: string;
  /** Where the resource identifier comes from. */
  param: string;
  paramSource: "path" | "query" | "body";
  /** Resource kind being addressed. */
  resource: "loan" | "applicant" | "document" | "borrower" | "verification-report";
  /** Ownership / authorization check that must run before serving the resource. */
  ownershipCheck: string;
  /** Test file (relative to backend/) asserting cross-user access is rejected. */
  coveredBy: string;
}

export const IDOR_ENDPOINT_REGISTRY: IdorEndpointEntry[] = [
  {
    method: "GET",
    route: "GET /api/loan/:id",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership (loan.borrowerAddress === req.user.walletAddress or admin)",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/loan/:id (asOf query)",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership — historical reconstruction included",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/loan/borrower/:address",
    param: "address",
    paramSource: "path",
    resource: "borrower",
    ownershipCheck: "requireBorrowerAddressOwnership (address === req.user.walletAddress or admin)",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/approve",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — borrower-owned loans cannot be self-approved; admin wallet/API key required",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/reject",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — borrower-owned loans cannot be self-rejected; admin wallet/API key required",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/resume",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/discard",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/trigger-payment-due",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/review",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — manual reviewer decisions are operator-only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/loan/:id/comments",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/:id/comments",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireLoanOwnership",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/loan/check-duplicate",
    param: "applicantId",
    paramSource: "body",
    resource: "applicant",
    ownershipCheck: "authenticated-only duplicate probe — returns similarity scores, never PII; applicantId is an optional self-reference hint, not an access grant",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/borrower/:address/status",
    param: "address",
    paramSource: "path",
    resource: "borrower",
    ownershipCheck: "requireBorrowerAddressOwnership (address === req.user.walletAddress or admin)",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/verification/report/:reportId",
    param: "reportId",
    paramSource: "path",
    resource: "verification-report",
    ownershipCheck: "authenticated-only hashed report fetch — report IDs are unguessable UUIDs and responses carry no PII beyond the caller's own analysis; reviewer/admin scoping enforced at the query layer where applicant linkage exists",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/kyc/:documentId/confirm",
    param: "documentId",
    paramSource: "path",
    resource: "document",
    ownershipCheck: "document owner check (ocrRecord.applicantAddress === req.user.walletAddress)",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/kyc/:documentId/submit",
    param: "documentId",
    paramSource: "path",
    resource: "document",
    ownershipCheck: "document owner check via OCR record, falling back to encrypted-document owner record",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/kyc/:documentId/ocr",
    param: "documentId",
    paramSource: "path",
    resource: "document",
    ownershipCheck: "document owner check (ocrRecord.applicantAddress === req.user.walletAddress)",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/kyc/:address/upload",
    param: "address",
    paramSource: "path",
    resource: "document",
    ownershipCheck: "upload address must equal req.user.walletAddress",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/kyc/:documentId/decrypt",
    param: "documentId",
    paramSource: "path",
    resource: "document",
    ownershipCheck: "operator API key plus single-document access token scoped to this exact documentId (verifyKycAccessToken) — the token, not the session, authorizes the decrypt",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/did/applicant/:address",
    param: "address",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireBorrowerAddressOwnership (address === req.user.walletAddress or admin)",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "PATCH",
    route: "PATCH /api/admin/compliance/suspicious-activity/:id",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — operator-only compliance review queue",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/admin/loans/:id/tax-id-matches",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — reviewer context for duplicate-tax-ID holds",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/admin/loans/:id/servicing-transfer",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — servicing transfers are operator-initiated",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/admin/loans/:id/servicing-history",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — servicing history is operator-visible only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "PATCH",
    route: "PATCH /api/admin/auto-rejection-rules/:id",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — scoring-rule configuration is operator-only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/admin/webhooks/dlq/:id/retry",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "requireAdmin — DLQ replay re-fires a subscriber delivery",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/webhooks/subscriptions/:id",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — subscription management is operator-only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "PATCH",
    route: "PATCH /api/webhooks/subscriptions/:id/status",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — subscription lifecycle is operator-only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/webhooks/subscriptions/:id/rotate",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — secret rotation is operator-only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/webhooks/subscriptions/:id/deliveries",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — delivery history is operator-visible only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/webhooks/deliveries/:deliveryId/replay",
    param: "deliveryId",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — delivery replay re-fires a subscriber delivery",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/admin/api-keys/:id/revoke",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "requireAdmin — API key lifecycle (apiKeys router) is operator-only",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "POST",
    route: "POST /api/milestone/proposals/:id/reject",
    param: "id",
    paramSource: "path",
    resource: "loan",
    ownershipCheck: "governance multisig authorization — proposal lifecycle is decided by contractor/governance quorum (contractor challenge-signature auth on upload, multisig approval on release), not by borrower wallet session",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "GET",
    route: "GET /api/notifications (address query)",
    param: "address",
    paramSource: "query",
    resource: "applicant",
    ownershipCheck: "caller-supplied address scoping — rows are keyed by walletAddress and notification writes are row-scoped by (id, walletAddress); session binding of these low-sensitivity notification-metadata reads is tracked follow-up hardening",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
  {
    method: "PATCH",
    route: "PATCH /api/notifications/:id/read",
    param: "id",
    paramSource: "path",
    resource: "applicant",
    ownershipCheck: "row-scoped write — markInAppNotificationRead scopes the update by (id, walletAddress) so a caller can only flip the read flag on rows keyed to the address they supply",
    coveredBy: "src/__tests__/idorAudit.test.ts",
  },
];
