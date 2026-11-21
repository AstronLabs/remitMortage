// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unified loan activity timeline (issue #1043) — service layer.
 *
 * The four event sources live in different tables, so the interesting
 * behaviour is the merge and the cross-source cursor. These tests drive the
 * service with an in-memory store that honours the same `where`/`orderBy`/
 * `take` shape the real Prisma client does, so paging across sources is
 * exercised for real (no duplicates, no gaps, correct ordering).
 */

import {
  getLoanActivityTimeline,
  decodeActivityCursor,
  InvalidActivityCursorError,
  DEFAULT_LOAN_ACTIVITY_LIMIT,
  MAX_LOAN_ACTIVITY_LIMIT,
  type LoanActivityEvent,
} from "../services/loanActivityTimeline.js";

const BORROWER_ADDRESS = "G" + "B".repeat(55);
const LOAN_ID = "loan-1";

// ── In-memory stand-in for the Prisma tables the service reads ──────────────

interface RepaymentRow {
  id: string;
  borrowerId: string;
  contractId: string;
  amount: string;
  ledger: number;
  createdAt: Date;
}
interface DocumentRow {
  id: string;
  applicantId: string;
  documentId: string;
  originalName: string;
  mimeType: string;
  uploadedAt: Date;
}
interface AuditRow {
  id: string;
  action: string;
  actorAddress: string | null;
  metadata: unknown;
  createdAt: Date;
}

function getByPath(obj: unknown, path: string[]): unknown {
  let cur: any = obj;
  for (const key of path) {
    if (cur == null) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Applies a Prisma-style `where` clause (the subset the service uses). */
function matchWhere(row: any, where: any = {}): boolean {
  if (where.action !== undefined) {
    const a = where.action;
    if (typeof a === "string" && row.action !== a) return false;
    if (a && Array.isArray(a.in) && !a.in.includes(row.action)) return false;
  }
  if (where.borrowerId !== undefined && row.borrowerId !== where.borrowerId) return false;
  if (where.applicantId !== undefined && row.applicantId !== where.applicantId) return false;
  if (where.createdAt?.lte && !(row.createdAt <= where.createdAt.lte)) return false;
  if (where.uploadedAt?.lte && !(row.uploadedAt <= where.uploadedAt.lte)) return false;
  if (where.metadata?.path && getByPath(row.metadata, where.metadata.path) !== where.metadata.equals) {
    return false;
  }
  if (Array.isArray(where.OR) && !where.OR.some((sub: any) => matchWhere(row, sub))) {
    return false;
  }
  return true;
}

function orderRows(rows: any[], orderBy: any[]): any[] {
  return [...rows].sort((a, b) => {
    for (const clause of orderBy) {
      const [field, dir] = Object.entries(clause)[0] as [string, string];
      if (a[field] < b[field]) return dir === "asc" ? -1 : 1;
      if (a[field] > b[field]) return dir === "asc" ? 1 : -1;
    }
    return 0;
  });
}

interface FakeData {
  borrower: { id: string; stellarAddress: string } | null;
  applicant: { id: string; stellarAddress: string } | null;
  repayments: RepaymentRow[];
  disbursements: RepaymentRow[];
  documents: DocumentRow[];
  auditLogs: AuditRow[];
}

function createFakePrisma(overrides: Partial<FakeData> = {}) {
  const data: FakeData = {
    borrower: { id: "borrower-1", stellarAddress: BORROWER_ADDRESS },
    applicant: { id: "applicant-1", stellarAddress: BORROWER_ADDRESS },
    repayments: [],
    disbursements: [],
    documents: [],
    auditLogs: [],
    ...overrides,
  };

  const findMany = (rows: any[]) =>
    jest.fn(async ({ where, orderBy, take }: any) => {
      const filtered = rows.filter((r) => matchWhere(r, where));
      const ordered = orderRows(filtered, orderBy ?? [{ createdAt: "desc" }, { id: "desc" }]);
      return take != null ? ordered.slice(0, take) : ordered;
    });

  return {
    borrower: {
      findUnique: jest.fn(async ({ where }: any) =>
        data.borrower && data.borrower.stellarAddress === where.stellarAddress ? data.borrower : null
      ),
    },
    applicant: {
      findFirst: jest.fn(async ({ where }: any) =>
        data.applicant && data.applicant.stellarAddress === where.stellarAddress ? data.applicant : null
      ),
    },
    loanRepayment: { findMany: findMany(data.repayments) },
    loanDisbursement: { findMany: findMany(data.disbursements) },
    kycDocument: { findMany: findMany(data.documents) },
    auditLog: { findMany: findMany(data.auditLogs) },
  } as any;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const at = (iso: string) => new Date(iso);

function repayment(id: string, iso: string): RepaymentRow {
  return { id, borrowerId: "borrower-1", contractId: "C1", amount: "100", ledger: 5, createdAt: at(iso) };
}
function disbursement(id: string, iso: string): RepaymentRow {
  return { id, borrowerId: "borrower-1", contractId: "C1", amount: "500", ledger: 4, createdAt: at(iso) };
}
function document(id: string, iso: string): DocumentRow {
  return {
    id,
    applicantId: "applicant-1",
    documentId: `doc-${id}`,
    originalName: `${id}.pdf`,
    mimeType: "application/pdf",
    uploadedAt: at(iso),
  };
}
function statusAudit(id: string, iso: string): AuditRow {
  return {
    id,
    action: "loan_application.updated",
    actorAddress: null,
    metadata: { applicationId: LOAN_ID, changes: { status: { from: "Pending", to: "Approved" } } },
    createdAt: at(iso),
  };
}
function adminAudit(id: string, iso: string): AuditRow {
  return {
    id,
    action: "loan_application.reassigned",
    actorAddress: "GADMIN",
    metadata: { applicationId: LOAN_ID, reviewerId: "R2" },
    createdAt: at(iso),
  };
}

const loanRef = { id: LOAN_ID, borrowerAddress: BORROWER_ADDRESS };

/** A fully mixed dataset with strictly increasing timestamps per event. */
function mixedDataset() {
  return createFakePrisma({
    disbursements: [disbursement("d1", "2026-01-01T00:00:00.000Z")],
    documents: [document("doc1", "2026-01-02T00:00:00.000Z")],
    auditLogs: [
      statusAudit("s1", "2026-01-03T00:00:00.000Z"),
      adminAudit("a1", "2026-01-05T00:00:00.000Z"),
    ],
    repayments: [repayment("r1", "2026-01-04T00:00:00.000Z")],
  });
}

describe("getLoanActivityTimeline — mixed-event ordering", () => {
  it("merges all four sources into one feed ordered newest first", async () => {
    const prisma = mixedDataset();

    const timeline = await getLoanActivityTimeline(loanRef, { prisma });

    expect(timeline.loanId).toBe(LOAN_ID);
    expect(timeline.events.map((e: LoanActivityEvent) => e.id)).toEqual([
      "admin:a1",
      "payment:repayment:r1",
      "status:s1",
      "document:doc1",
      "payment:disbursement:d1",
    ]);
    expect(timeline.events.map((e: LoanActivityEvent) => e.type)).toEqual([
      "admin_action",
      "payment",
      "status_change",
      "document",
      "payment",
    ]);
    expect(timeline.pagination).toEqual({
      limit: DEFAULT_LOAN_ACTIVITY_LIMIT,
      cursor: null,
      nextCursor: null,
      hasNextPage: false,
    });
  });

  it("derives the resulting status for a status-change entry", async () => {
    const prisma = mixedDataset();

    const timeline = await getLoanActivityTimeline(loanRef, { prisma });
    const statusEvent = timeline.events.find((e: LoanActivityEvent) => e.id === "status:s1");

    expect(statusEvent?.status).toBe("Approved");
    expect(statusEvent?.metadata).toEqual({ from: "Pending", to: "Approved" });
  });

  it("returns events sorted strictly descending by occurredAt", async () => {
    const timeline = await getLoanActivityTimeline(loanRef, { prisma: mixedDataset() });

    const times = timeline.events.map((e: LoanActivityEvent) => Date.parse(e.occurredAt));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
    }
  });
});

describe("getLoanActivityTimeline — cross-source cursor pagination", () => {
  const dataset = () =>
    createFakePrisma({
      repayments: [
        repayment("r1", "2026-01-01T00:00:00.000Z"),
        repayment("r2", "2026-01-04T00:00:00.000Z"),
      ],
      disbursements: [disbursement("d1", "2026-01-02T00:00:00.000Z")],
      documents: [document("doc1", "2026-01-05T00:00:00.000Z")],
      auditLogs: [
        statusAudit("s1", "2026-01-03T00:00:00.000Z"),
        adminAudit("a1", "2026-01-06T00:00:00.000Z"),
      ],
    });

  it("pages across event types with no duplicates or gaps", async () => {
    const prisma = dataset();

    const seen: string[] = [];
    let cursor: string | null | undefined;
    let pages = 0;
    let hasNextPage = true;

    while (hasNextPage) {
      const page = await getLoanActivityTimeline(loanRef, { prisma, limit: 2, cursor });
      seen.push(...page.events.map((e: LoanActivityEvent) => e.id));
      hasNextPage = page.pagination.hasNextPage;
      cursor = page.pagination.nextCursor;
      pages += 1;
      if (pages > 10) throw new Error("pagination did not terminate");
    }

    // All six events, each exactly once, still in global descending order.
    expect(seen).toEqual([
      "admin:a1",
      "document:doc1",
      "payment:repayment:r2",
      "status:s1",
      "payment:disbursement:d1",
      "payment:repayment:r1",
    ]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBe(3);
  });

  it("marks the last page as terminal with a null nextCursor", async () => {
    const prisma = dataset();

    const first = await getLoanActivityTimeline(loanRef, { prisma, limit: 5 });
    expect(first.pagination.hasNextPage).toBe(true);
    expect(first.pagination.nextCursor).not.toBeNull();

    const second = await getLoanActivityTimeline(loanRef, {
      prisma,
      limit: 5,
      cursor: first.pagination.nextCursor,
    });
    expect(second.pagination.hasNextPage).toBe(false);
    expect(second.pagination.nextCursor).toBeNull();
    expect(second.events).toHaveLength(1);
  });

  it("echoes the cursor the page was requested with", async () => {
    const prisma = dataset();

    const first = await getLoanActivityTimeline(loanRef, { prisma, limit: 2 });
    const second = await getLoanActivityTimeline(loanRef, {
      prisma,
      limit: 2,
      cursor: first.pagination.nextCursor,
    });

    expect(second.pagination.cursor).toBe(first.pagination.nextCursor);
  });
});

describe("getLoanActivityTimeline — cursor and limit handling", () => {
  it("rejects a malformed cursor with InvalidActivityCursorError", async () => {
    await expect(
      getLoanActivityTimeline(loanRef, { prisma: mixedDataset(), cursor: "not-a-cursor" })
    ).rejects.toBeInstanceOf(InvalidActivityCursorError);
  });

  it("round-trips an opaque cursor through decodeActivityCursor", () => {
    const decoded = decodeActivityCursor(Buffer.from(JSON.stringify({
      t: "2026-01-01T00:00:00.000Z",
      i: "payment:repayment:r1",
    })).toString("base64url"));

    expect(decoded).toEqual({
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      id: "payment:repayment:r1",
    });
  });

  it("clamps an oversized limit to the maximum", async () => {
    const timeline = await getLoanActivityTimeline(loanRef, {
      prisma: mixedDataset(),
      limit: 10_000,
    });

    expect(timeline.pagination.limit).toBe(MAX_LOAN_ACTIVITY_LIMIT);
  });

  it("falls back to the default limit when the value is not finite", async () => {
    const timeline = await getLoanActivityTimeline(loanRef, {
      prisma: mixedDataset(),
      limit: Number.NaN,
    });

    expect(timeline.pagination.limit).toBe(DEFAULT_LOAN_ACTIVITY_LIMIT);
  });

  it("returns an empty feed when the borrower has no money movements", async () => {
    const timeline = await getLoanActivityTimeline(loanRef, {
      prisma: createFakePrisma({ borrower: null, applicant: null }),
    });

    expect(timeline.events).toEqual([]);
    expect(timeline.pagination.hasNextPage).toBe(false);
  });
});

describe("getLoanActivityTimeline — reviewer handoff (issue #1101)", () => {
  const NOTE = "Appraisal ordered; still need the co-borrower's ID.";
  const handoffDataset = () =>
    createFakePrisma({
      borrower: null,
      applicant: null,
      auditLogs: [
        {
          id: "h1",
          action: "loan_application.reassigned",
          actorAddress: "GADMIN",
          metadata: {
            applicationId: LOAN_ID,
            reviewerId: "R2",
            reviewerEmail: "r2@example.com",
            previousReviewerId: "R1",
            previousReviewerEmail: "r1@example.com",
            handoffNote: NOTE,
          },
          createdAt: at("2026-02-01T00:00:00.000Z"),
        },
      ],
    });

  it("records the handoff, including the note, as a timeline entry for reviewers", async () => {
    const timeline = await getLoanActivityTimeline(loanRef, {
      prisma: handoffDataset(),
      includeInternalNotes: true,
    });

    expect(timeline.events).toHaveLength(1);
    expect(timeline.events[0]).toMatchObject({
      id: "admin:h1",
      type: "admin_action",
      source: "loan_application.reassigned",
      summary: `Reviewer handoff from r1@example.com to r2@example.com: ${NOTE}`,
      metadata: expect.objectContaining({ handoffNote: NOTE, previousReviewerId: "R1" }),
    });
  });

  it("withholds the internal handoff note unless explicitly requested", async () => {
    const timeline = await getLoanActivityTimeline(loanRef, { prisma: handoffDataset() });

    expect(timeline.events[0].summary).toBe("Reviewer reassigned");
    expect(timeline.events[0].metadata).not.toHaveProperty("handoffNote");
    expect(JSON.stringify(timeline.events[0])).not.toContain(NOTE);
  });
});
