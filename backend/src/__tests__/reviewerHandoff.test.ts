// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Reviewer handoff context (issue #1101): the incoming reviewer sees the
 * latest handoff note together with every earlier handoff and the
 * application's prior activity history.
 */

import { getReviewerHandoffContext, toReviewerHandoff } from "../services/reviewerHandoff.js";

jest.mock("../services/db.js", () => ({ prisma: {} }));

const APPLICATION_ID = "app-1";

function handoffRow(id: string, iso: string, from: string | null, to: string, note: string | null) {
  return {
    id,
    actorAddress: "GADMIN",
    createdAt: new Date(iso),
    metadata: {
      applicationId: APPLICATION_ID,
      previousReviewerId: from,
      previousReviewerEmail: from ? `${from}@example.com` : null,
      reviewerId: to,
      reviewerEmail: `${to}@example.com`,
      handoffNote: note,
    },
  };
}

const HISTORY = [
  {
    id: "status:s1",
    type: "status_change" as const,
    occurredAt: "2026-01-01T00:00:00.000Z",
    summary: "Status changed to UnderReview",
    source: "loan_application.updated",
  },
];

function setup(rows: ReturnType<typeof handoffRow>[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const getTimeline = jest.fn().mockResolvedValue({
    loanId: APPLICATION_ID,
    events: HISTORY,
    pagination: { limit: 20, cursor: null, nextCursor: null, hasNextPage: false },
  });
  const prisma = { auditLog: { findMany } } as any;
  return { prisma, findMany, getTimeline };
}

describe("getReviewerHandoffContext", () => {
  it("returns the latest handoff note alongside all handoffs and prior history", async () => {
    const { prisma, findMany, getTimeline } = setup([
      handoffRow("h2", "2026-01-03T00:00:00.000Z", "b", "c", "Waiting on appraisal."),
      handoffRow("h1", "2026-01-02T00:00:00.000Z", "a", "b", "Docs verified."),
    ]);

    const context = await getReviewerHandoffContext(
      { id: APPLICATION_ID, borrowerAddress: "GBORROWER", assignedReviewerId: "c" },
      { prisma, getTimeline },
    );

    expect(context.latestHandoff).toMatchObject({
      id: "h2",
      fromReviewerId: "b",
      toReviewerId: "c",
      toReviewerEmail: "c@example.com",
      note: "Waiting on appraisal.",
    });
    expect(context.handoffs.map((h) => h.id)).toEqual(["h2", "h1"]);
    expect(context.history).toEqual(HISTORY);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          action: "loan_application.reassigned",
          metadata: { path: ["applicationId"], equals: APPLICATION_ID },
        },
      }),
    );
    expect(getTimeline).toHaveBeenCalledWith(
      { id: APPLICATION_ID, borrowerAddress: "GBORROWER" },
      expect.objectContaining({ includeInternalNotes: true }),
    );
  });

  it("does not present a stale handoff when the current reviewer differs", async () => {
    const { prisma, getTimeline } = setup([
      handoffRow("h1", "2026-01-02T00:00:00.000Z", "a", "b", "Docs verified."),
    ]);

    const context = await getReviewerHandoffContext(
      { id: APPLICATION_ID, borrowerAddress: "GBORROWER", assignedReviewerId: "z" },
      { prisma, getTimeline },
    );

    expect(context.latestHandoff).toBeNull();
    expect(context.handoffs).toHaveLength(1);
  });

  it("returns an empty handoff list for an application never handed off", async () => {
    const { prisma, getTimeline } = setup([]);

    const context = await getReviewerHandoffContext(
      { id: APPLICATION_ID, borrowerAddress: "GBORROWER", assignedReviewerId: "a" },
      { prisma, getTimeline },
    );

    expect(context.latestHandoff).toBeNull();
    expect(context.handoffs).toEqual([]);
    expect(context.history).toEqual(HISTORY);
  });
});

describe("toReviewerHandoff", () => {
  it("tolerates legacy reassignment rows without a note or emails", () => {
    const handoff = toReviewerHandoff({
      id: "old",
      actorAddress: null,
      createdAt: new Date("2025-12-01T00:00:00.000Z"),
      metadata: { applicationId: APPLICATION_ID, reviewerId: "b", previousReviewerId: "a" },
    });

    expect(handoff).toEqual({
      id: "old",
      occurredAt: "2025-12-01T00:00:00.000Z",
      fromReviewerId: "a",
      fromReviewerEmail: null,
      toReviewerId: "b",
      toReviewerEmail: null,
      note: null,
      actorAddress: null,
    });
  });
});
