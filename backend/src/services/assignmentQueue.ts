// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Configurable round-robin assignment queue for loan applications (issue #621).
 *
 * New applications are distributed across active review staff so that none sits
 * unclaimed and two reviewers never double-work the same application. The queue
 * is "least recently assigned wins": the active reviewer whose
 * {@link ReviewerLike.lastAssignedAt} is oldest (never-assigned first) receives
 * the next application, making the distribution even and guaranteeing that no
 * reviewer is picked twice in a row while another is idle.
 *
 * The selection itself is a pure function ({@link selectNextReviewer}) so the
 * fairness guarantee can be tested without a database.
 */

import { prisma } from "./db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

/** Availability of a review-staff member. Mirrors the Prisma `ReviewerStatus`. */
export type ReviewerStatus = "ACTIVE" | "INACTIVE" | "ON_LEAVE";

/** The fields of a reviewer that the rotation cares about. */
export interface ReviewerLike {
  id: string;
  email?: string | null;
  name?: string | null;
  status: ReviewerStatus | string;
  lastAssignedAt: Date | null;
}

/** True when a reviewer is eligible to receive new assignments. */
export function isReviewerActive(reviewer: Pick<ReviewerLike, "status">): boolean {
  return reviewer.status === "ACTIVE";
}

/**
 * Orders reviewers by least-recently-assigned first. Never-assigned reviewers
 * (null `lastAssignedAt`) always come first; ties fall back to the reviewer id
 * so the ordering is independent of query order.
 */
function compareByLeastRecentlyAssigned(a: ReviewerLike, b: ReviewerLike): number {
  const aTime = a.lastAssignedAt ? a.lastAssignedAt.getTime() : Number.NEGATIVE_INFINITY;
  const bTime = b.lastAssignedAt ? b.lastAssignedAt.getTime() : Number.NEGATIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Picks the next reviewer in round-robin order, excluding anyone who is not
 * `ACTIVE` (inactive or on leave). Returns `null` when no reviewer is available.
 */
export function selectNextReviewer<T extends ReviewerLike>(
  reviewers: readonly T[]
): T | null {
  const available = reviewers.filter(isReviewerActive);
  if (available.length === 0) return null;
  return [...available].sort(compareByLeastRecentlyAssigned)[0];
}

/** Error carrying a stable machine code and HTTP status for route handlers. */
export class AssignmentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "AssignmentError";
  }
}

/** Minimal structural view of the Prisma client used here, for injectability. */
export interface AssignmentClient {
  reviewer: {
    findMany: (args: { where?: unknown; orderBy?: unknown }) => Promise<any[]>;
    findUnique: (args: { where: { id: string } }) => Promise<any>;
    create: (args: { data: any }) => Promise<any>;
    update: (args: { where: { id: string }; data: any }) => Promise<any>;
  };
  loanApplication: {
    findFirst: (args: { where: unknown }) => Promise<any>;
    update: (args: { where: { id: string }; data: any }) => Promise<any>;
  };
  auditLog?: {
    create: (args: { data: any }) => Promise<any>;
  };
  $transaction: <T>(fn: (tx: AssignmentClient) => Promise<T>) => Promise<T>;
}

export interface AssignmentOptions {
  /** Override the Prisma client (tests). Defaults to the shared client. */
  client?: AssignmentClient;
  /** Injectable clock (tests). Defaults to `new Date()`. */
  now?: () => Date;
}

export interface AssignmentResult {
  assigned: boolean;
  applicationId: string;
  reviewerId?: string;
  reviewerEmail?: string | null;
  /** Present when `assigned` is false. */
  reason?: "no_active_reviewers" | "assignment_disabled" | "assignment_failed";
}

function resolveClient(options: AssignmentOptions): AssignmentClient {
  return options.client ?? (prisma as unknown as AssignmentClient);
}

/**
 * Assigns the next application to the least-recently-assigned active reviewer.
 * Returns `assigned: false` (never throws) when the rotation is empty, so a
 * submission is never blocked by queue configuration.
 */
export async function assignReviewerToApplication(
  applicationId: string,
  options: AssignmentOptions = {}
): Promise<AssignmentResult> {
  const client = resolveClient(options);
  const assignedAt = (options.now ?? (() => new Date()))();

  const reviewers = await client.reviewer.findMany({ where: { status: "ACTIVE" } });
  const next = selectNextReviewer(reviewers as ReviewerLike[]);
  if (!next) {
    logger.warn("[assignment-queue] No active reviewers available", { applicationId });
    return { assigned: false, applicationId, reason: "no_active_reviewers" };
  }

  await client.$transaction(async (tx) => {
    await tx.reviewer.update({
      where: { id: next.id },
      data: { lastAssignedAt: assignedAt },
    });
    await tx.loanApplication.update({
      where: { id: applicationId },
      data: {
        assignedReviewerId: next.id,
        assignedReviewerEmail: next.email ?? null,
        assignedAt,
      },
    });
  });

  return {
    assigned: true,
    applicationId,
    reviewerId: next.id,
    reviewerEmail: next.email ?? null,
  };
}

/**
 * Auto-assignment entry point for the submission path. Honours the
 * `ASSIGNMENT_QUEUE_ENABLED` config flag and swallows failures so application
 * creation can never fail because of the queue.
 */
export async function autoAssignApplicationReviewer(
  applicationId: string,
  options: AssignmentOptions & { config?: { assignmentQueueEnabled: boolean } } = {}
): Promise<AssignmentResult> {
  const config = options.config ?? loadConfig();
  if (!config.assignmentQueueEnabled) {
    return { assigned: false, applicationId, reason: "assignment_disabled" };
  }
  try {
    return await assignReviewerToApplication(applicationId, options);
  } catch (error) {
    logger.error("[assignment-queue] Auto-assignment failed", { applicationId, error });
    return { assigned: false, applicationId, reason: "assignment_failed" };
  }
}

export interface ReassignOptions extends AssignmentOptions {
  actorAddress?: string | null;
  ipAddress?: string | null;
}

/**
 * Manual override: force-assigns an application to a specific reviewer.
 * Rejects unknown reviewers and anyone not `ACTIVE`, so an inactive or
 * on-leave reviewer can never be handed an application.
 */
export async function reassignApplicationReviewer(
  applicationId: string,
  reviewerId: string,
  options: ReassignOptions = {}
): Promise<{ applicationId: string; reviewerId: string; reviewerEmail: string | null; assignedAt: Date }> {
  const client = resolveClient(options);

  const reviewer = await client.reviewer.findUnique({ where: { id: reviewerId } });
  if (!reviewer) {
    throw new AssignmentError("reviewer_not_found", "Reviewer not found", 404);
  }
  if (!isReviewerActive(reviewer)) {
    throw new AssignmentError(
      "reviewer_inactive",
      "Cannot assign to an inactive or on-leave reviewer",
      409
    );
  }

  const application = await client.loanApplication.findFirst({
    where: { id: applicationId, deletedAt: null },
  });
  if (!application) {
    throw new AssignmentError("application_not_found", "Application not found", 404);
  }

  const assignedAt = (options.now ?? (() => new Date()))();
  const previousReviewerId = application.assignedReviewerId ?? null;

  await client.$transaction(async (tx) => {
    await tx.reviewer.update({
      where: { id: reviewerId },
      data: { lastAssignedAt: assignedAt },
    });
    await tx.loanApplication.update({
      where: { id: applicationId },
      data: {
        assignedReviewerId: reviewerId,
        assignedReviewerEmail: reviewer.email ?? null,
        assignedAt,
      },
    });
    if (tx.auditLog) {
      await tx.auditLog.create({
        data: {
          action: "loan_application.reassigned",
          actorAddress: options.actorAddress ?? "admin",
          ipAddress: options.ipAddress ?? null,
          metadata: {
            applicationId,
            reviewerId,
            previousReviewerId,
            assignedAt: assignedAt.toISOString(),
          },
        },
      });
    }
  });

  return { applicationId, reviewerId, reviewerEmail: reviewer.email ?? null, assignedAt };
}

export interface ReviewerInput {
  email: string;
  name?: string | null;
  status?: ReviewerStatus;
}

/** Creates a review-staff member. Emails are normalized to lower case. */
export async function createReviewer(
  input: ReviewerInput,
  options: AssignmentOptions = {}
): Promise<any> {
  const client = resolveClient(options);
  return client.reviewer.create({
    data: {
      email: input.email.trim().toLowerCase(),
      name: input.name ?? null,
      status: input.status ?? "ACTIVE",
    },
  });
}

/** Lists review staff, oldest first. */
export async function listReviewers(options: AssignmentOptions = {}): Promise<any[]> {
  const client = resolveClient(options);
  return client.reviewer.findMany({ orderBy: { createdAt: "asc" } });
}

/** Updates a reviewer's name/email/availability. */
export async function updateReviewer(
  id: string,
  patch: { name?: string | null; email?: string; status?: ReviewerStatus },
  options: AssignmentOptions = {}
): Promise<any> {
  const client = resolveClient(options);
  return client.reviewer.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.email !== undefined ? { email: patch.email.trim().toLowerCase() } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  });
}
