// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";
import type { LoanApplication } from "./loanStore.js";

/**
 * Point-in-time reconstruction of a loan application's state.
 *
 * The `LoanApplication` row in Postgres only ever holds the *current* value of
 * each field. To answer "what did this loan look like on date X" for support
 * and compliance, every mutation is also written to the `AuditLog` table as a
 * field-level change set. Replaying those change sets in chronological order,
 * starting from the creation snapshot, rebuilds the exact state the API would
 * have returned at any past timestamp.
 *
 * See {@link recordLoanCreation} / {@link recordLoanChange} for the writer side
 * and {@link reconstructLoanApplicationAt} for the reader side.
 */

/** Fields whose changes are tracked in the audit trail and replayed here. */
export const RECONSTRUCTABLE_FIELDS = [
  "borrowerAddress",
  "amount",
  "status",
  "reason",
] as const;

export type ReconstructableField = (typeof RECONSTRUCTABLE_FIELDS)[number];

/** The mutable slice of a loan application that reconstruction tracks. */
export type LoanSnapshot = Pick<LoanApplication, ReconstructableField>;

export interface LoanFieldChange<T = unknown> {
  from: T;
  to: T;
}

export type LoanChangeSet = Partial<{
  [K in ReconstructableField]: LoanFieldChange<LoanApplication[K]>;
}>;

/** Every loan audit action shares this prefix so the trail can be scanned. */
export const LOAN_AUDIT_ACTION_PREFIX = "loan_application.";
export const LOAN_CREATED_ACTION = `${LOAN_AUDIT_ACTION_PREFIX}created`;
export const LOAN_UPDATED_ACTION = `${LOAN_AUDIT_ACTION_PREFIX}updated`;

interface AuditContext {
  actorAddress?: string;
  ipAddress?: string;
}

/**
 * Compute the field-level diff between two loan snapshots, restricted to the
 * fields reconstruction knows how to replay. Returns an empty object when
 * nothing tracked has changed.
 */
export function diffLoanSnapshot(
  before: LoanSnapshot,
  after: LoanSnapshot,
): LoanChangeSet {
  const changes: LoanChangeSet = {};
  for (const field of RECONSTRUCTABLE_FIELDS) {
    if (before[field] !== after[field]) {
      // The generic index dance keeps each entry's `from`/`to` typed to the field.
      (changes[field] as LoanFieldChange | undefined) = {
        from: before[field],
        to: after[field],
      } as LoanFieldChange;
    }
  }
  return changes;
}

/** Record the creation snapshot that seeds every later reconstruction. */
export async function recordLoanCreation(
  applicationId: string,
  snapshot: LoanSnapshot,
  ctx: AuditContext = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: LOAN_CREATED_ACTION,
      actorAddress: ctx.actorAddress,
      ipAddress: ctx.ipAddress,
      metadata: { applicationId, snapshot },
    },
  });
}

/**
 * Record a field-level change set for a loan application. A no-op when the
 * change set is empty, so callers can diff unconditionally.
 */
export async function recordLoanChange(
  applicationId: string,
  changes: LoanChangeSet,
  ctx: AuditContext = {},
  action: string = LOAN_UPDATED_ACTION,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await prisma.auditLog.create({
    data: {
      action,
      actorAddress: ctx.actorAddress,
      ipAddress: ctx.ipAddress,
      metadata: { applicationId, changes },
    },
  });
}

type LoanAuditEntry = {
  action: string;
  createdAt: Date;
  metadata: unknown;
};

/** Pull the ordered loan audit trail up to and including `asOf`. */
async function loadLoanAuditTrail(
  applicationId: string,
  asOf: Date,
): Promise<LoanAuditEntry[]> {
  return prisma.auditLog.findMany({
    where: {
      action: { startsWith: LOAN_AUDIT_ACTION_PREFIX },
      createdAt: { lte: asOf },
      metadata: { path: ["applicationId"], equals: applicationId },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { action: true, createdAt: true, metadata: true },
  });
}

function readMetadata(entry: LoanAuditEntry): Record<string, unknown> {
  return entry.metadata && typeof entry.metadata === "object"
    ? (entry.metadata as Record<string, unknown>)
    : {};
}

export interface ReconstructOptions {
  /**
   * Fallback seed used only for loans created before creation snapshots were
   * written to the audit trail. Immutable identity fields (`id`, `createdAt`)
   * come from the live row regardless.
   */
  fallbackSeed?: LoanSnapshot;
}

/**
 * Reconstruct the state of a loan application as it stood at `asOf`.
 *
 * Returns `null` when the application does not exist, or when `asOf` predates
 * its creation. Omitting `asOf` at the call site should keep returning the
 * live record — this function is only for the historical path.
 */
export async function reconstructLoanApplicationAt(
  applicationId: string,
  asOf: Date,
  options: ReconstructOptions = {},
): Promise<LoanApplication | null> {
  const record = await prisma.loanApplication.findFirst({
    where: { id: applicationId, deletedAt: null },
    include: { applicant: true },
  });
  if (!record) return null;

  // Nothing existed before the row was created.
  if (asOf.getTime() < record.createdAt.getTime()) return null;

  const trail = await loadLoanAuditTrail(applicationId, asOf);
  const creation = trail.find((e) => e.action === LOAN_CREATED_ACTION);

  let snapshot: LoanSnapshot;
  let updatedAt: Date = record.createdAt;

  if (creation) {
    snapshot = { ...(readMetadata(creation).snapshot as LoanSnapshot) };
    updatedAt = creation.createdAt;
  } else if (options.fallbackSeed) {
    // Legacy loan with no creation snapshot: best-effort seed from the caller,
    // then still replay any change sets that were recorded afterwards.
    snapshot = { ...options.fallbackSeed };
  } else {
    return null;
  }

  for (const entry of trail) {
    if (entry.action === LOAN_CREATED_ACTION) continue;
    const changes = readMetadata(entry).changes as LoanChangeSet | undefined;
    if (!changes) continue;
    for (const field of RECONSTRUCTABLE_FIELDS) {
      const change = changes[field] as LoanFieldChange | undefined;
      if (change) {
        (snapshot[field] as unknown) = change.to;
      }
    }
    updatedAt = entry.createdAt;
  }

  return {
    id: record.id,
    borrowerAddress: snapshot.borrowerAddress,
    amount: snapshot.amount,
    status: snapshot.status,
    reason: snapshot.reason ?? undefined,
    createdAt: record.createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}
