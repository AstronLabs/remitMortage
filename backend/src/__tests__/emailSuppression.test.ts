// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Issue #694: email bounce handling and suppression list.
 */

import express from "express";
import request from "supertest";

type Row = Record<string, any>;
const rows = new Map<string, Row>();
const mockPreferenceFindMany = jest.fn();

jest.mock("../services/db.js", () => ({
  prisma: {
    emailSuppression: {
      findUnique: jest.fn(
        async ({ where }: any) => rows.get(where.email) ?? null,
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.email);
        const next = existing
          ? { ...existing, ...update }
          : { softBounceCount: 0, flaggedForReview: false, ...create };
        rows.set(where.email, next);
        return next;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const next = { ...rows.get(where.email), ...data };
        rows.set(where.email, next);
        return next;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const now: Date = where.OR[1].suppressedUntil.gt;
        return [...rows.values()].filter(
          (r) => r.permanent || (r.suppressedUntil && r.suppressedUntil > now),
        );
      }),
    },
    notificationPreference: {
      findMany: (...args: any[]) => mockPreferenceFindMany(...args),
    },
  },
}));

jest.mock("../config.js", () => ({
  loadConfig: () => ({ emailWebhookSecret: "test-secret" }),
}));

jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  classifyProviderEvent,
  isEmailSuppressed,
  listSuppressedApplicants,
  recordEmailEvent,
  softBounceBackoffMs,
  SOFT_BOUNCE_BASE_BACKOFF_MS,
  SOFT_BOUNCE_LIMIT,
  SOFT_BOUNCE_MAX_BACKOFF_MS,
} from "../services/emailSuppression.js";
import { emailEventsRouter } from "../routes/emailEvents.js";

const NOW = new Date("2026-09-26T12:00:00Z");

beforeEach(() => {
  rows.clear();
  mockPreferenceFindMany.mockReset();
});

describe("classifyProviderEvent", () => {
  it("distinguishes hard bounces, soft bounces and complaints", () => {
    expect(classifyProviderEvent({ event: "bounce", type: "bounce" })).toBe(
      "hard",
    );
    expect(classifyProviderEvent({ event: "bounce" })).toBe("hard");
    expect(classifyProviderEvent({ event: "bounce", type: "blocked" })).toBe(
      "soft",
    );
    expect(classifyProviderEvent({ event: "deferred" })).toBe("soft");
    expect(classifyProviderEvent({ event: "spamreport" })).toBe("complaint");
    expect(
      classifyProviderEvent({ event: "dropped", reason: "Bounced Address" }),
    ).toBe("hard");
  });

  it("ignores events that do not affect deliverability", () => {
    expect(classifyProviderEvent({ event: "delivered" })).toBeNull();
    expect(classifyProviderEvent({ event: "open" })).toBeNull();
    expect(
      classifyProviderEvent({
        event: "dropped",
        reason: "Unsubscribed Address",
      }),
    ).toBeNull();
  });
});

describe("softBounceBackoffMs", () => {
  it("doubles per soft bounce and is capped", () => {
    expect(softBounceBackoffMs(1)).toBe(SOFT_BOUNCE_BASE_BACKOFF_MS);
    expect(softBounceBackoffMs(2)).toBe(SOFT_BOUNCE_BASE_BACKOFF_MS * 2);
    expect(softBounceBackoffMs(3)).toBe(SOFT_BOUNCE_BASE_BACKOFF_MS * 4);
    expect(softBounceBackoffMs(50)).toBe(SOFT_BOUNCE_MAX_BACKOFF_MS);
  });
});

describe("recordEmailEvent / isEmailSuppressed", () => {
  it("permanently suppresses a hard-bounced address (case-insensitive)", async () => {
    await expect(
      recordEmailEvent(
        { email: "User@Example.com", event: "bounce", type: "bounce" },
        NOW,
      ),
    ).resolves.toBe("hard");

    const row = rows.get("user@example.com")!;
    expect(row.reason).toBe("HARD_BOUNCE");
    expect(row.permanent).toBe(true);
    await expect(isEmailSuppressed("user@example.com", NOW)).resolves.toBe(
      true,
    );
    await expect(
      isEmailSuppressed("USER@example.com", new Date("2030-01-01")),
    ).resolves.toBe(true);
  });

  it("permanently suppresses and flags a spam complaint", async () => {
    await recordEmailEvent(
      { email: "angry@example.com", event: "spamreport" },
      NOW,
    );

    const row = rows.get("angry@example.com")!;
    expect(row.reason).toBe("SPAM_COMPLAINT");
    expect(row.permanent).toBe(true);
    expect(row.flaggedForReview).toBe(true);
    await expect(isEmailSuppressed("angry@example.com", NOW)).resolves.toBe(
      true,
    );

    // A later hard bounce does not downgrade the complaint.
    await recordEmailEvent(
      { email: "angry@example.com", event: "bounce" },
      NOW,
    );
    expect(rows.get("angry@example.com")!.reason).toBe("SPAM_COMPLAINT");
    expect(rows.get("angry@example.com")!.flaggedForReview).toBe(true);
  });

  it("suppresses a soft-bounced address only for the backoff window", async () => {
    await recordEmailEvent(
      { email: "full@example.com", event: "deferred" },
      NOW,
    );

    const row = rows.get("full@example.com")!;
    expect(row.reason).toBe("SOFT_BOUNCE");
    expect(row.permanent).toBe(false);
    expect(row.softBounceCount).toBe(1);

    await expect(isEmailSuppressed("full@example.com", NOW)).resolves.toBe(
      true,
    );
    const afterWindow = new Date(
      NOW.getTime() + SOFT_BOUNCE_BASE_BACKOFF_MS + 1,
    );
    await expect(
      isEmailSuppressed("full@example.com", afterWindow),
    ).resolves.toBe(false);

    // The next soft bounce doubles the window.
    await recordEmailEvent(
      { email: "full@example.com", event: "deferred" },
      NOW,
    );
    expect(rows.get("full@example.com")!.suppressedUntil).toEqual(
      new Date(NOW.getTime() + SOFT_BOUNCE_BASE_BACKOFF_MS * 2),
    );
  });

  it("escalates repeated soft bounces to permanent suppression", async () => {
    for (let i = 0; i < SOFT_BOUNCE_LIMIT; i++) {
      await recordEmailEvent(
        { email: "flaky@example.com", event: "deferred" },
        NOW,
      );
    }
    const row = rows.get("flaky@example.com")!;
    expect(row.permanent).toBe(true);
    expect(row.reason).toBe("HARD_BOUNCE");
    await expect(
      isEmailSuppressed("flaky@example.com", new Date("2030-01-01")),
    ).resolves.toBe(true);
  });

  it("keeps a permanent entry permanent when a soft bounce follows", async () => {
    await recordEmailEvent({ email: "gone@example.com", event: "bounce" }, NOW);
    await recordEmailEvent(
      { email: "gone@example.com", event: "deferred" },
      NOW,
    );
    expect(rows.get("gone@example.com")!.permanent).toBe(true);
  });

  it("ignores non-bounce events and malformed addresses", async () => {
    await expect(
      recordEmailEvent({ email: "ok@example.com", event: "delivered" }, NOW),
    ).resolves.toBeNull();
    await expect(
      recordEmailEvent({ email: "not-an-email", event: "bounce" }, NOW),
    ).resolves.toBeNull();
    expect(rows.size).toBe(0);
    await expect(isEmailSuppressed("ok@example.com", NOW)).resolves.toBe(false);
  });
});

describe("listSuppressedApplicants", () => {
  it("returns suppressed addresses with the matching applicants", async () => {
    await recordEmailEvent({ email: "a@example.com", event: "bounce" }, NOW);
    await recordEmailEvent(
      { email: "b@example.com", event: "spamreport" },
      NOW,
    );
    mockPreferenceFindMany.mockResolvedValue([
      {
        email: "A@example.com",
        applicantId: "app-1",
        applicant: { stellarAddress: "GAAA" },
      },
    ]);

    const result = await listSuppressedApplicants(NOW);

    expect(result).toHaveLength(2);
    const a = result.find((r) => r.email === "a@example.com")!;
    expect(a.applicants).toEqual([
      { applicantId: "app-1", stellarAddress: "GAAA" },
    ]);
    const b = result.find((r) => r.email === "b@example.com")!;
    expect(b.flaggedForReview).toBe(true);
    expect(b.applicants).toEqual([]);
  });
});

describe("POST /api/webhooks/email-events", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/webhooks/email-events", emailEventsRouter);

  it("rejects requests without the shared secret", async () => {
    const res = await request(app)
      .post("/api/webhooks/email-events")
      .send([{ email: "x@example.com", event: "bounce" }]);
    expect(res.status).toBe(401);
    expect(rows.size).toBe(0);
  });

  it("records a batch of provider events", async () => {
    const res = await request(app)
      .post("/api/webhooks/email-events")
      .set("x-webhook-token", "test-secret")
      .send([
        { email: "hard@example.com", event: "bounce", type: "bounce" },
        { email: "soft@example.com", event: "deferred" },
        { email: "spam@example.com", event: "spamreport" },
        { email: "fine@example.com", event: "delivered" },
      ]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      processed: 4,
      hard: 1,
      soft: 1,
      complaint: 1,
      ignored: 1,
    });
    expect(rows.get("hard@example.com")!.permanent).toBe(true);
    expect(rows.get("spam@example.com")!.flaggedForReview).toBe(true);
  });

  it("rejects a non-object payload", async () => {
    const res = await request(app)
      .post("/api/webhooks/email-events?token=test-secret")
      .set("Content-Type", "application/json")
      .send('"nope"');
    expect(res.status).toBe(400);
  });
});
