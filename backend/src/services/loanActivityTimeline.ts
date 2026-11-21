// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unified loan activity timeline (issue #1043).
 *
 * A single loan's history is scattered across several tables: on-chain money
 * movements (`LoanDisbursement` / `LoanRepayment`), the loan audit trail
 * (`AuditLog` rows with the `loan_application.*` prefix), KYC document uploads
 * (`KycDocument`), and operator actions (servicing transfers, fee-waiver
 * decisions, reviewer reassignments, comments). Building a combined history
 * view otherwise means four separate queries stitched together on the client.
 *
 * This module merges those four sources into one chronological feed and pages
 * it with the same keyset ("cursor") convention as `/api/audit-logs`. Because
 * the events live in different tables, the cursor is an opaque token that
 * encodes the `(occurredAt, id)` of the last event returned, which is what
 * makes cross-source pagination stable and duplicate-free.
 */

import { prisma as defaultPrisma } from "./db.js";
import { LOAN_AUDIT_ACTION_PREFIX } from "./loanHistory.js";

export type LoanActivityEventType =
  | "payment"
  | "status_change"
  | "document"
  | "admin_action";

export interface LoanActivityEvent {
  /** Stable, source-prefixed id so ids from different tables never collide. */
  id: string;
  type: LoanActivityEventType;
  /** ISO-8601 timestamp the event is ordered and paginated by. */
  occurredAt: string;
  /** Human-readable one-liner for the feed. */
  summary: string;
  /** The underlying table or audit action this event was derived from. */
  source: string;
  amount?: string;
  /** Resulting status, for `status_change` events. */
  status?: string;
  actorAddress?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LoanActivityPagination {
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface LoanActivityTimeline {
  loanId: string;
  events: LoanActivityEvent[];
  pagination: LoanActivityPagination;
}

/** The immutable slice of a loan this feed needs to resolve its sources. */
export interface LoanActivityLoanRef {
  id: string;
  borrowerAddress: string;
}

export interface GetLoanActivityTimelineOptions {
  prisma?: typeof defaultPrisma;
  /** Page size. Defaults to {@link DEFAULT_LOAN_ACTIVITY_LIMIT}. */
  limit?: number;
  /** Cursor from a previous page's `nextCursor`. Omit for the first page. */
  cursor?: string | null;
  /**
   * Include operator-only notes (reviewer handoff notes, issue #1101). Off by
   * default so a borrower reading their own timeline never sees internal
   * review commentary; reviewer/admin callers opt in.
   */
  includeInternalNotes?: boolean;
}

export const DEFAULT_LOAN_ACTIVITY_LIMIT = 20;
export const MAX_LOAN_ACTIVITY_LIMIT = 100;

/** Thrown when a caller supplies a cursor this module cannot decode. */
export class InvalidActivityCursorError extends Error {
  readonly code = "invalid_cursor" as const;
  constructor() {
    super("cursor is not a valid activity timeline cursor");
    this.name = "InvalidActivityCursorError";
  }
}

/** Audit actions that log a loan status transition. */
const STATUS_CHANGE_ACTIONS = [
  `${LOAN_AUDIT_ACTION_PREFIX}created`,
  `${LOAN_AUDIT_ACTION_PREFIX}updated`,
  `${LOAN_AUDIT_ACTION_PREFIX}manual_status_change`,
  `${LOAN_AUDIT_ACTION_PREFIX}auto_rejected`,
  `${LOAN_AUDIT_ACTION_PREFIX}bulk_approved`,
  `${LOAN_AUDIT_ACTION_PREFIX}bulk_rejected`,
];

/** Operator actions logged against a loan, outside the status-change stream. */
const ADMIN_ACTION_ACTIONS = [
  `${LOAN_AUDIT_ACTION_PREFIX}reassigned`,
  "loan_comment",
  "LOAN_SERVICING_TRANSFER_SCHEDULED",
  "LOAN_SERVICING_TRANSFER_COMPLETED",
  "LATE_FEE_WAIVER_REQUESTED",
  "LATE_FEE_WAIVER_DECIDED",
];

interface TimelineCursor {
  occurredAt: Date;
  id: string;
}

/** Shape of an on-chain money-movement row (`LoanRepayment` / `LoanDisbursement`). */
interface PaymentRow {
  id: string;
  amount: string;
  createdAt: Date;
  contractId: string;
  ledger: number;
}

/** Shape of a `KycDocument` row used by the timeline. */
interface DocumentRow {
  id: string;
  originalName: string;
  uploadedAt: Date;
  documentId: string;
  mimeType: string;
}

/** Shape of an `AuditLog` row used by the timeline. */
interface AuditRow {
  id: string;
  action: string;
  actorAddress: string | null;
  metadata: unknown;
  createdAt: Date;
}

/** Encode the position of `event` so the next page can resume strictly after it. */
function encodeCursor(event: Pick<LoanActivityEvent, "occurredAt" | "id">): string {
  return Buffer.from(JSON.stringify({ t: event.occurredAt, i: event.id })).toString("base64url");
}

/** Decode an opaque cursor, returning null when it is malformed. */
export function decodeActivityCursor(cursor: string): TimelineCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof parsed?.t !== "string" || typeof parsed?.i !== "string") return null;
    const occurredAt = new Date(parsed.t);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id: parsed.i };
  } catch {
    return null;
  }
}

/** Newest first, ties broken by id descending so the order is total and stable. */
function compareEventsDesc(
  a: Pick<LoanActivityEvent, "occurredAt" | "id">,
  b: Pick<LoanActivityEvent, "occurredAt" | "id">,
): number {
  const at = Date.parse(a.occurredAt);
  const bt = Date.parse(b.occurredAt);
  if (at !== bt) return bt - at;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/**
 * Money movements recorded on-chain for the loan's borrower: disbursements paid
 * out and repayments paid in. Events are keyed by borrower address, which is
 * how the loan links to them.
 */
async function fetchPaymentEvents(
  prisma: typeof defaultPrisma,
  loan: LoanActivityLoanRef,
  cursor: TimelineCursor | null,
  take: number,
): Promise<LoanActivityEvent[]> {
  const borrower = await prisma.borrower.findUnique({
    where: { stellarAddress: loan.borrowerAddress },
    select: { id: true },
  });
  if (!borrower) return [];

  const timeFilter = cursor ? { createdAt: { lte: cursor.occurredAt } } : {};
  const [repayments, disbursements] = await Promise.all([
    prisma.loanRepayment.findMany({
      where: { borrowerId: borrower.id, ...timeFilter },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    }),
    prisma.loanDisbursement.findMany({
      where: { borrowerId: borrower.id, ...timeFilter },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    }),
  ]);

  return [
    ...(repayments as PaymentRow[]).map((r) => ({
      id: `payment:repayment:${r.id}`,
      type: "payment" as const,
      occurredAt: iso(r.createdAt),
      summary: `Repayment of ${r.amount}`,
      source: "loan_repayment",
      amount: r.amount,
      metadata: { contractId: r.contractId, ledger: r.ledger },
    })),
    ...(disbursements as PaymentRow[]).map((d) => ({
      id: `payment:disbursement:${d.id}`,
      type: "payment" as const,
      occurredAt: iso(d.createdAt),
      summary: `Disbursement of ${d.amount}`,
      source: "loan_disbursement",
      amount: d.amount,
      metadata: { contractId: d.contractId, ledger: d.ledger },
    })),
  ];
}

/**
 * Status transitions reconstructed from the loan audit trail. Only entries
 * whose change set (or creation snapshot / auto-rejection) yields a resulting
 * status are surfaced, so unrelated field edits don't pollute the timeline.
 */
async function fetchStatusChangeEvents(
  prisma: typeof defaultPrisma,
  loan: LoanActivityLoanRef,
  cursor: TimelineCursor | null,
  take: number,
): Promise<LoanActivityEvent[]> {
  const timeFilter = cursor ? { createdAt: { lte: cursor.occurredAt } } : {};
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: STATUS_CHANGE_ACTIONS },
      metadata: { path: ["applicationId"], equals: loan.id },
      ...timeFilter,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });

  const events: LoanActivityEvent[] = [];
  for (const row of rows) {
    const meta = asObject(row.metadata);
    const statusChange = asObject(asObject(meta.changes).status);

    let status: string | undefined;
    let from: string | undefined;
    if (row.action === `${LOAN_AUDIT_ACTION_PREFIX}created`) {
      const snapshot = asObject(meta.snapshot);
      status = typeof snapshot.status === "string" ? snapshot.status : undefined;
    } else if (typeof statusChange.to === "string") {
      status = statusChange.to;
      from = typeof statusChange.from === "string" ? statusChange.from : undefined;
    } else if (row.action === `${LOAN_AUDIT_ACTION_PREFIX}auto_rejected`) {
      status = "Rejected";
    }
    if (!status) continue;

    const isCreation = row.action === `${LOAN_AUDIT_ACTION_PREFIX}created`;
    // Manual status changes carry the operator's reason (issue #1102).
    const reason = asObject(meta.statusChangeReason);
    const reasonLabel = typeof reason.label === "string" ? reason.label : undefined;
    const reasonNote = typeof reason.note === "string" ? reason.note : undefined;
    const statusSummary = isCreation ? `Loan application created (${status})` : `Status changed to ${status}`;
    events.push({
      id: `status:${row.id}`,
      type: "status_change",
      occurredAt: iso(row.createdAt),
      summary: reasonLabel
        ? `${statusSummary} — ${reasonNote ? `${reasonLabel}: ${reasonNote}` : reasonLabel}`
        : statusSummary,
      source: row.action,
      status,
      actorAddress: row.actorAddress ?? null,
      metadata: {
        from,
        to: status,
        ...(typeof reason.code === "string"
          ? { reasonCode: reason.code, reasonLabel, ...(reasonNote ? { reasonNote } : {}) }
          : {}),
      },
    });
  }
  return events;
}

/**
 * KYC document uploads for the loan's applicant. Documents are attached to the
 * applicant, and a loan belongs to exactly one applicant, so this is the loan's
 * document history.
 */
async function fetchDocumentEvents(
  prisma: typeof defaultPrisma,
  loan: LoanActivityLoanRef,
  cursor: TimelineCursor | null,
  take: number,
): Promise<LoanActivityEvent[]> {
  const applicant = await prisma.applicant.findFirst({
    where: { stellarAddress: loan.borrowerAddress, deletedAt: null },
    select: { id: true },
  });
  if (!applicant) return [];

  const timeFilter = cursor ? { uploadedAt: { lte: cursor.occurredAt } } : {};
  const docs = await prisma.kycDocument.findMany({
    where: { applicantId: applicant.id, ...timeFilter },
    orderBy: [{ uploadedAt: "desc" }, { id: "desc" }],
    take,
  });

  return (docs as DocumentRow[]).map((doc) => ({
    id: `document:${doc.id}`,
    type: "document" as const,
    occurredAt: iso(doc.uploadedAt),
    summary: `Document uploaded: ${doc.originalName}`,
    source: "kyc_document",
    metadata: { documentId: doc.documentId, mimeType: doc.mimeType },
  }));
}

/** Metadata keys that only operators may see on the timeline. */
const INTERNAL_NOTE_KEYS = ["handoffNote"];

function withoutInternalNotes(meta: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...meta };
  for (const key of INTERNAL_NOTE_KEYS) delete copy[key];
  return copy;
}

/** One-line description of a reviewer reassignment / handoff. */
function reassignmentSummary(meta: Record<string, unknown>): string {
  const from = typeof meta.previousReviewerEmail === "string" ? meta.previousReviewerEmail : null;
  const to = typeof meta.reviewerEmail === "string" ? meta.reviewerEmail : null;
  const note = typeof meta.handoffNote === "string" && meta.handoffNote ? meta.handoffNote : null;
  if (!note) return "Reviewer reassigned";
  return `Reviewer handoff${from ? ` from ${from}` : ""}${to ? ` to ${to}` : ""}: ${note}`;
}

/** One-line description of an operator action, best-effort from its metadata. */
function adminActionSummary(action: string, meta: Record<string, unknown>): string {
  switch (action) {
    case `${LOAN_AUDIT_ACTION_PREFIX}reassigned`:
      return reassignmentSummary(meta);
    case "loan_comment":
      return "Comment added";
    case "LOAN_SERVICING_TRANSFER_SCHEDULED":
      return `Servicing transfer scheduled${meta.toServicer ? ` to ${meta.toServicer}` : ""}`;
    case "LOAN_SERVICING_TRANSFER_COMPLETED":
      return `Servicing transfer completed${meta.toServicer ? ` to ${meta.toServicer}` : ""}`;
    case "LATE_FEE_WAIVER_REQUESTED":
      return "Late fee waiver requested";
    case "LATE_FEE_WAIVER_DECIDED":
      return `Late fee waiver ${typeof meta.status === "string" ? meta.status.toLowerCase() : "decided"}`;
    default:
      return action;
  }
}

/**
 * Operator actions logged against the loan: reassignments, comments, servicing
 * transfers and fee-waiver decisions. Scoped by whichever application-id key the
 * writer used (`applicationId`, `loanId` or `loanApplicationId`).
 */
async function fetchAdminActionEvents(
  prisma: typeof defaultPrisma,
  loan: LoanActivityLoanRef,
  cursor: TimelineCursor | null,
  take: number,
  includeInternalNotes: boolean,
): Promise<LoanActivityEvent[]> {
  const timeFilter = cursor ? { createdAt: { lte: cursor.occurredAt } } : {};
  const rows = await prisma.auditLog.findMany({
    where: {
      action: { in: ADMIN_ACTION_ACTIONS },
      OR: [
        { metadata: { path: ["applicationId"], equals: loan.id } },
        { metadata: { path: ["loanId"], equals: loan.id } },
        { metadata: { path: ["loanApplicationId"], equals: loan.id } },
      ],
      ...timeFilter,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take,
  });

  return (rows as AuditRow[]).map((row) => {
    const raw = asObject(row.metadata);
    const meta = includeInternalNotes ? raw : withoutInternalNotes(raw);
    return {
      id: `admin:${row.id}`,
      type: "admin_action" as const,
      occurredAt: iso(row.createdAt),
      summary: adminActionSummary(row.action, meta),
      source: row.action,
      actorAddress: row.actorAddress ?? null,
      metadata: meta,
    };
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LOAN_ACTIVITY_LIMIT;
  return Math.max(1, Math.min(MAX_LOAN_ACTIVITY_LIMIT, Math.floor(limit)));
}

/**
 * Build one loan's chronological activity feed.
 *
 * All four sources are fetched with the cursor applied, merged, sorted newest
 * first, then trimmed to a page. One extra row is requested per source and one
 * extra event is kept after merging, which is how `hasNextPage` is detected
 * without a separate count.
 */
export async function getLoanActivityTimeline(
  loan: LoanActivityLoanRef,
  options: GetLoanActivityTimelineOptions = {},
): Promise<LoanActivityTimeline> {
  const prisma = options.prisma ?? defaultPrisma;
  const limit = clampLimit(options.limit);

  let cursor: TimelineCursor | null = null;
  if (options.cursor) {
    cursor = decodeActivityCursor(options.cursor);
    if (!cursor) throw new InvalidActivityCursorError();
  }

  const take = limit + 1;
  const [payments, statusChanges, documents, adminActions] = await Promise.all([
    fetchPaymentEvents(prisma, loan, cursor, take),
    fetchStatusChangeEvents(prisma, loan, cursor, take),
    fetchDocumentEvents(prisma, loan, cursor, take),
    fetchAdminActionEvents(prisma, loan, cursor, take, options.includeInternalNotes ?? false),
  ]);

  let merged = [...payments, ...statusChanges, ...documents, ...adminActions].sort(
    compareEventsDesc,
  );

  // Per-source queries only bound by time; drop the cursor event itself and
  // anything newer so paging never repeats or skips an event.
  if (cursor) {
    const boundary = { occurredAt: cursor.occurredAt.toISOString(), id: cursor.id };
    merged = merged.filter((event) => compareEventsDesc(event, boundary) > 0);
  }

  const hasNextPage = merged.length > limit;
  const events = hasNextPage ? merged.slice(0, limit) : merged;
  const nextCursor = hasNextPage ? encodeCursor(events[events.length - 1]) : null;

  return {
    loanId: loan.id,
    events,
    pagination: {
      limit,
      cursor: options.cursor ?? null,
      nextCursor,
      hasNextPage,
    },
  };
}
