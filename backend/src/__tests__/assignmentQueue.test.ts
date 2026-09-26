// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for the configurable round-robin application assignment queue
 * (issue #621). The selection algorithm is pure and exercised directly; the
 * persistence paths run against an in-memory fake Prisma client.
 */

import {
  AssignmentError,
  assignReviewerToApplication,
  autoAssignApplicationReviewer,
  createReviewer,
  isReviewerActive,
  reassignApplicationReviewer,
  selectNextReviewer,
  updateReviewer,
  type AssignmentClient,
} from "../services/assignmentQueue.js";

jest.mock("../services/db.js", () => ({ prisma: {} }));

interface FakeReviewer {
  id: string;
  email: string;
  name: string | null;
  status: "ACTIVE" | "INACTIVE" | "ON_LEAVE";
  lastAssignedAt: Date | null;
}

function reviewer(overrides: Partial<FakeReviewer> & { id: string }): FakeReviewer {
  return {
    email: `${overrides.id}@example.com`,
    name: null,
    status: "ACTIVE",
    lastAssignedAt: null,
    ...overrides,
  };
}

/** Minimal in-memory Prisma stand-in backing the assignment service. */
function createFakeClient(seed: FakeReviewer[]) {
  const reviewers = seed.map((r) => ({ ...r }));
  const applications = new Map<string, any>();
  const auditLogs: any[] = [];

  const client: any = {
    reviewers,
    applications,
    auditLogs,
    reviewer: {
      findMany: async ({ where }: any = {}) =>
        reviewers.filter((r) => !where?.status || r.status === where.status).map((r) => ({ ...r })),
      findUnique: async ({ where }: any) => reviewers.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: any) => {
        const created = { id: `rev-${reviewers.length + 1}`, lastAssignedAt: null, ...data };
        reviewers.push(created);
        return created;
      },
      update: async ({ where, data }: any) => {
        const target = reviewers.find((r) => r.id === where.id);
        if (!target) throw Object.assign(new Error("not found"), { code: "P2025" });
        Object.assign(target, data);
        return { ...target };
      },
    },
    loanApplication: {
      findFirst: async ({ where }: any) => applications.get(where.id) ?? null,
      update: async ({ where, data }: any) => {
        const existing = applications.get(where.id) ?? { id: where.id, deletedAt: null };
        Object.assign(existing, data);
        applications.set(where.id, existing);
        return { ...existing };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        auditLogs.push(data);
        return data;
      },
    },
  };
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(client);
  return client as AssignmentClient & {
    reviewers: FakeReviewer[];
    applications: Map<string, any>;
    auditLogs: any[];
  };
}

const BASE_NOW = new Date("2026-09-26T00:00:00.000Z");

describe("selectNextReviewer", () => {
  it("distributes evenly and never picks the same reviewer twice in a row", () => {
    const pool = [
      reviewer({ id: "a" }),
      reviewer({ id: "b" }),
      reviewer({ id: "c" }),
    ];

    const picks: string[] = [];
    let tick = 0;
    for (let i = 0; i < 6; i++) {
      const next = selectNextReviewer(pool)!;
      picks.push(next.id);
      // Stamp the pick so the next round sees it as most recently assigned.
      pool.find((r) => r.id === next.id)!.lastAssignedAt = new Date(BASE_NOW.getTime() + tick++);
    }

    expect(picks).toEqual(["a", "b", "c", "a", "b", "c"]);
    const counts = picks.reduce<Record<string, number>>((acc, id) => {
      acc[id] = (acc[id] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ a: 2, b: 2, c: 2 });
    for (let i = 1; i < picks.length; i++) {
      expect(picks[i]).not.toBe(picks[i - 1]);
    }
  });

  it("excludes inactive and on-leave reviewers from the rotation", () => {
    const pool = [
      reviewer({ id: "active", lastAssignedAt: new Date("2026-01-01") }),
      reviewer({ id: "gone", status: "INACTIVE", lastAssignedAt: null }),
      reviewer({ id: "away", status: "ON_LEAVE", lastAssignedAt: null }),
    ];

    expect(selectNextReviewer(pool)?.id).toBe("active");
    // Even after the only active reviewer was just assigned, the inactive ones
    // must not be picked up.
    pool[0].lastAssignedAt = new Date("2026-12-31");
    expect(selectNextReviewer(pool)?.id).toBe("active");
  });

  it("prefers never-assigned reviewers over previously assigned ones", () => {
    const pool = [
      reviewer({ id: "veteran", lastAssignedAt: new Date(BASE_NOW) }),
      reviewer({ id: "fresh", lastAssignedAt: null }),
    ];
    expect(selectNextReviewer(pool)?.id).toBe("fresh");
  });

  it("uses the reviewer id as a deterministic tie-break", () => {
    const pool = [reviewer({ id: "z" }), reviewer({ id: "a" }), reviewer({ id: "m" })];
    expect(selectNextReviewer(pool)?.id).toBe("a");
  });

  it("returns null when no active reviewer exists", () => {
    expect(selectNextReviewer([reviewer({ id: "x", status: "INACTIVE" })])).toBeNull();
    expect(selectNextReviewer([])).toBeNull();
  });
});

describe("isReviewerActive", () => {
  it("is true only for ACTIVE", () => {
    expect(isReviewerActive({ status: "ACTIVE" })).toBe(true);
    expect(isReviewerActive({ status: "INACTIVE" })).toBe(false);
    expect(isReviewerActive({ status: "ON_LEAVE" })).toBe(false);
  });
});

describe("assignReviewerToApplication", () => {
  it("assigns the least-recently-assigned active reviewer and stamps the records", async () => {
    const client = createFakeClient([
      reviewer({ id: "a", lastAssignedAt: new Date("2026-09-25T00:00:00Z") }),
      reviewer({ id: "b", lastAssignedAt: new Date("2026-09-20T00:00:00Z") }),
      reviewer({ id: "c", status: "INACTIVE" }),
    ]);

    const result = await assignReviewerToApplication("app-1", {
      client,
      now: () => BASE_NOW,
    });

    expect(result).toMatchObject({ assigned: true, applicationId: "app-1", reviewerId: "b" });
    const b = client.reviewers.find((r) => r.id === "b")!;
    expect(b.lastAssignedAt).toEqual(BASE_NOW);
    expect(client.applications.get("app-1")).toMatchObject({
      assignedReviewerId: "b",
      assignedReviewerEmail: "b@example.com",
      assignedAt: BASE_NOW,
    });
  });

  it("returns no_active_reviewers (without throwing) when everyone is inactive", async () => {
    const client = createFakeClient([
      reviewer({ id: "a", status: "INACTIVE" }),
      reviewer({ id: "b", status: "ON_LEAVE" }),
    ]);

    const result = await assignReviewerToApplication("app-1", { client });

    expect(result).toMatchObject({ assigned: false, reason: "no_active_reviewers" });
    expect(client.applications.has("app-1")).toBe(false);
  });

  it("distributes a burst of applications evenly across active reviewers", async () => {
    const client = createFakeClient([
      reviewer({ id: "a" }),
      reviewer({ id: "b" }),
      reviewer({ id: "c" }),
      reviewer({ id: "paused", status: "ON_LEAVE" }),
    ]);

    const assigned: string[] = [];
    let tick = 0;
    for (let i = 0; i < 6; i++) {
      const now = new Date(BASE_NOW.getTime() + tick++ * 60_000);
      const result = await assignReviewerToApplication(`app-${i}`, { client, now: () => now });
      assigned.push(result.reviewerId!);
    }

    expect(assigned).toEqual(["a", "b", "c", "a", "b", "c"]);
    expect(assigned).not.toContain("paused");
  });
});

describe("reassignApplicationReviewer", () => {
  function withApplication(client: ReturnType<typeof createFakeClient>, id: string) {
    client.applications.set(id, { id, deletedAt: null, assignedReviewerId: "a" });
  }

  it("reassigns to an active reviewer and writes an audit log", async () => {
    const client = createFakeClient([
      reviewer({ id: "a" }),
      reviewer({ id: "b" }),
    ]);
    withApplication(client, "app-1");

    const result = await reassignApplicationReviewer("app-1", "b", {
      client,
      now: () => BASE_NOW,
      actorAddress: "GADMIN",
      ipAddress: "127.0.0.1",
    });

    expect(result).toMatchObject({ applicationId: "app-1", reviewerId: "b" });
    expect(client.applications.get("app-1")).toMatchObject({
      assignedReviewerId: "b",
      assignedReviewerEmail: "b@example.com",
    });
    expect(client.auditLogs).toHaveLength(1);
    expect(client.auditLogs[0]).toMatchObject({
      action: "loan_application.reassigned",
      actorAddress: "GADMIN",
      metadata: { applicationId: "app-1", reviewerId: "b", previousReviewerId: "a" },
    });
  });

  it("rejects an inactive reviewer", async () => {
    const client = createFakeClient([
      reviewer({ id: "a" }),
      reviewer({ id: "away", status: "ON_LEAVE" }),
    ]);
    withApplication(client, "app-1");

    await expect(
      reassignApplicationReviewer("app-1", "away", { client })
    ).rejects.toMatchObject({ code: "reviewer_inactive", status: 409 });
    expect(client.applications.get("app-1").assignedReviewerId).toBe("a");
  });

  it("rejects an unknown reviewer", async () => {
    const client = createFakeClient([reviewer({ id: "a" })]);
    withApplication(client, "app-1");

    await expect(
      reassignApplicationReviewer("app-1", "ghost", { client })
    ).rejects.toMatchObject({ code: "reviewer_not_found", status: 404 });
  });

  it("rejects an unknown application", async () => {
    const client = createFakeClient([reviewer({ id: "a" })]);

    await expect(
      reassignApplicationReviewer("missing", "a", { client })
    ).rejects.toBeInstanceOf(AssignmentError);
    await expect(
      reassignApplicationReviewer("missing", "a", { client })
    ).rejects.toMatchObject({ code: "application_not_found", status: 404 });
  });
});

describe("autoAssignApplicationReviewer", () => {
  it("skips when the queue is disabled by config", async () => {
    const client = createFakeClient([reviewer({ id: "a" })]);

    const result = await autoAssignApplicationReviewer("app-1", {
      client,
      config: { assignmentQueueEnabled: false },
    });

    expect(result).toMatchObject({ assigned: false, reason: "assignment_disabled" });
    expect(client.applications.has("app-1")).toBe(false);
  });

  it("assigns when enabled", async () => {
    const client = createFakeClient([reviewer({ id: "a" })]);

    const result = await autoAssignApplicationReviewer("app-1", {
      client,
      config: { assignmentQueueEnabled: true },
      now: () => BASE_NOW,
    });

    expect(result).toMatchObject({ assigned: true, reviewerId: "a" });
  });

  it("never throws when the underlying client fails", async () => {
    const broken = {
      reviewer: { findMany: async () => { throw new Error("db down"); } },
      loanApplication: {},
      $transaction: async () => { throw new Error("db down"); },
    } as unknown as AssignmentClient;

    const result = await autoAssignApplicationReviewer("app-1", {
      client: broken,
      config: { assignmentQueueEnabled: true },
    });

    expect(result).toMatchObject({ assigned: false, reason: "assignment_failed" });
  });
});

describe("reviewer management", () => {
  it("normalizes emails to lower case on create", async () => {
    const client = createFakeClient([]);
    const created = await createReviewer({ email: "  Reviewer@Example.COM " }, { client });
    expect(created.email).toBe("reviewer@example.com");
    expect(created.status).toBe("ACTIVE");
  });

  it("can flip a reviewer to inactive so the rotation skips them", async () => {
    const client = createFakeClient([reviewer({ id: "a" }), reviewer({ id: "b" })]);
    await updateReviewer("a", { status: "INACTIVE" }, { client });

    const next = selectNextReviewer(client.reviewers);
    expect(next?.id).toBe("b");
  });
});
