// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Reviewer handoff context (issue #1101).
 *
 * When an application moves from one reviewer to another, the outgoing
 * reviewer must leave a handoff note (enforced by
 * {@link reassignApplicationReviewer}). This module is the read side: it gives
 * the reviewer who opens the application the most recent handoff note next to
 * every earlier handoff and the application's prior activity, so they can pick
 * up exactly where the previous reviewer left off.
 */

import { prisma as defaultPrisma } from "./db.js";
import { REASSIGNED_AUDIT_ACTION } from "./assignmentQueue.js";
import {
  getLoanActivityTimeline,
  type LoanActivityEvent,
  type LoanActivityLoanRef,
} from "./loanActivityTimeline.js";

export interface ReviewerHandoff {
  /** Audit log row the handoff was recorded as. */
  id: string;
  occurredAt: string;
  fromReviewerId: string | null;
  fromReviewerEmail: string | null;
  toReviewerId: string | null;
  toReviewerEmail: string | null;
  note: string | null;
  actorAddress: string | null;
}

export interface ReviewerHandoffContext {
  applicationId: string;
  assignedReviewerId: string | null;
  assignedReviewerEmail: string | null;
  /** The handoff that brought the application to its current reviewer, if any. */
  latestHandoff: ReviewerHandoff | null;
  /** Every handoff, newest first. */
  handoffs: ReviewerHandoff[];
  /** Prior review history from the unified activity timeline, newest first. */
  history: LoanActivityEvent[];
}

export interface GetReviewerHandoffContextOptions {
  prisma?: typeof defaultPrisma;
  /** Number of history events to include. Defaults to the timeline default. */
  historyLimit?: number;
  /** Injectable timeline reader (tests). */
  getTimeline?: typeof getLoanActivityTimeline;
}

/** The slice of the application this module needs. */
export interface HandoffApplicationRef extends LoanActivityLoanRef {
  assignedReviewerId?: string | null;
  assignedReviewerEmail?: string | null;
}

interface AuditRow {
  id: string;
  actorAddress: string | null;
  metadata: unknown;
  createdAt: Date;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Map a `loan_application.reassigned` audit row to a handoff record. */
export function toReviewerHandoff(row: AuditRow): ReviewerHandoff {
  const meta = asObject(row.metadata);
  return {
    id: row.id,
    occurredAt: (row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt)).toISOString(),
    fromReviewerId: stringOrNull(meta.previousReviewerId),
    fromReviewerEmail: stringOrNull(meta.previousReviewerEmail),
    toReviewerId: stringOrNull(meta.reviewerId),
    toReviewerEmail: stringOrNull(meta.reviewerEmail),
    note: stringOrNull(meta.handoffNote),
    actorAddress: row.actorAddress ?? null,
  };
}

/**
 * Builds the handoff view for an application: the latest handoff note, all
 * handoffs, and the prior activity history, in one response.
 */
export async function getReviewerHandoffContext(
  application: HandoffApplicationRef,
  options: GetReviewerHandoffContextOptions = {},
): Promise<ReviewerHandoffContext> {
  const prisma = options.prisma ?? defaultPrisma;
  const getTimeline = options.getTimeline ?? getLoanActivityTimeline;

  const [rows, timeline] = await Promise.all([
    prisma.auditLog.findMany({
      where: {
        action: REASSIGNED_AUDIT_ACTION,
        metadata: { path: ["applicationId"], equals: application.id },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
    getTimeline(
      { id: application.id, borrowerAddress: application.borrowerAddress },
      { prisma, limit: options.historyLimit, includeInternalNotes: true },
    ),
  ]);

  const handoffs = (rows as AuditRow[]).map(toReviewerHandoff);
  const latest = handoffs[0] ?? null;
  // Only surface the latest handoff when it is the one that brought the
  // application to the reviewer it is assigned to now.
  const assignedReviewerId = application.assignedReviewerId ?? null;
  const latestHandoff =
    latest && (assignedReviewerId === null || latest.toReviewerId === assignedReviewerId)
      ? latest
      : null;

  return {
    applicationId: application.id,
    assignedReviewerId,
    assignedReviewerEmail: application.assignedReviewerEmail ?? null,
    latestHandoff,
    handoffs,
    history: timeline.events,
  };
}
