// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  aggregateSlowQueries,
  buildSlowQueryDigestHtml,
  buildSlowQueryDigestSlackText,
  getConfiguredRecipients,
  runSlowQueryDigestJob,
} from "../jobs/slowQueryDigest";
import type { SlowQueryRecord } from "../services/slowQueryLog";

const WINDOW_END = new Date("2026-09-25T00:00:00.000Z");
const WINDOW_START = new Date("2026-09-18T00:00:00.000Z");

function rec(
  fingerprint: string,
  query: string,
  durationMs: number,
  occurredAt: Date = new Date("2026-09-20T00:00:00.000Z")
): SlowQueryRecord {
  return {
    fingerprint,
    query,
    model: "AuditLog",
    operation: "findMany",
    durationMs,
    occurredAt,
  };
}

// Pattern A: 5 calls, avg 120 ms. Pattern C: 5 calls, avg 70 ms.
// Pattern B: 3 calls, avg 600 ms. Pattern D: outside the window.
const RECORDS: SlowQueryRecord[] = [
  ...["100", "110", "120", "130", "140"].map((d, i) =>
    rec("fp-a", "A.findMany", Number(d), new Date(`2026-09-${19 + i}T00:00:00.000Z`))
  ),
  ...["500", "600", "700"].map((d, i) =>
    rec("fp-b", "B.findMany", Number(d), new Date(`2026-09-2${i + 1}T00:00:00.000Z`))
  ),
  ...["50", "60", "70", "80", "90"].map((d, i) =>
    rec("fp-c", "C.findMany", Number(d), new Date(`2026-09-${19 + i}T12:00:00.000Z`))
  ),
  rec("fp-d", "D.findMany", 900, new Date("2026-09-17T23:59:59.000Z")),
];

describe("aggregateSlowQueries", () => {
  const options = { since: WINDOW_START, until: WINDOW_END };

  it("filters to the window and computes per-pattern statistics", () => {
    const data = aggregateSlowQueries(RECORDS, options);

    expect(data.totalSlowQueries).toBe(13);
    const a = data.patterns.find((p) => p.fingerprint === "fp-a")!;
    expect(a).toMatchObject({
      query: "A.findMany",
      count: 5,
      totalDurationMs: 600,
      averageDurationMs: 120,
      minDurationMs: 100,
      maxDurationMs: 140,
    });
  });

  it("ranks by frequency with average duration as the tie-breaker", () => {
    const data = aggregateSlowQueries(RECORDS, options);

    expect(data.patterns.map((p) => p.fingerprint)).toEqual(["fp-a", "fp-c", "fp-b"]);
    expect(data.patterns[0].count).toBe(5);
    expect(data.patterns[0].averageDurationMs).toBe(120);
    // Both A and C were called 5x, but A is slower on average.
    expect(data.patterns[1].fingerprint).toBe("fp-c");
  });

  it("ranks by average duration when requested", () => {
    const data = aggregateSlowQueries(RECORDS, { ...options, rankBy: "duration" });

    expect(data.patterns.map((p) => p.fingerprint)).toEqual(["fp-b", "fp-a", "fp-c"]);
    expect(data.patterns[0].averageDurationMs).toBe(600);
  });

  it("caps the ranked list with topN", () => {
    const data = aggregateSlowQueries(RECORDS, { ...options, topN: 2 });
    expect(data.patterns).toHaveLength(2);
  });

  it("returns an empty digest when nothing is in the window", () => {
    const data = aggregateSlowQueries([], options);
    expect(data.totalSlowQueries).toBe(0);
    expect(data.patterns).toEqual([]);
  });
});

describe("digest rendering", () => {
  const data = aggregateSlowQueries(RECORDS, { since: WINDOW_START, until: WINDOW_END });

  it("renders the ranked patterns into the HTML email", () => {
    const html = buildSlowQueryDigestHtml(data);
    expect(html).toContain("Weekly Slow Query Digest");
    expect(html).toContain("A.findMany");
    expect(html).toContain("<strong>5</strong>");
    expect(html).toContain("120.0 ms");
    expect(html).toContain("140.0 ms");
  });

  it("escapes HTML in query patterns", () => {
    const malicious = aggregateSlowQueries(
      [rec("fp-x", "X.findMany <script>", 500)],
      { since: WINDOW_START, until: WINDOW_END }
    );
    expect(buildSlowQueryDigestHtml(malicious)).not.toContain("<script>");
    expect(buildSlowQueryDigestHtml(malicious)).toContain("&lt;script&gt;");
  });

  it("renders a Slack message with the ranking", () => {
    const text = buildSlowQueryDigestSlackText(data);
    expect(text).toContain(":snail:");
    expect(text).toContain("A.findMany");
    expect(text).toContain("5x");
  });
});

describe("getConfiguredRecipients", () => {
  afterEach(() => {
    delete process.env.SLOW_QUERY_DIGEST_RECIPIENTS;
  });

  it("parses a comma-separated list and drops blanks", () => {
    process.env.SLOW_QUERY_DIGEST_RECIPIENTS = " db@example.com , ops@example.com ,";
    expect(getConfiguredRecipients()).toEqual(["db@example.com", "ops@example.com"]);
  });

  it("returns an empty list when unset", () => {
    expect(getConfiguredRecipients()).toEqual([]);
  });
});

describe("runSlowQueryDigestJob", () => {
  const baseOptions = {
    records: RECORDS,
    now: () => WINDOW_END,
    windowDays: 7,
    sendSlack: async () => true,
  };

  it("emails the ranked digest to every recipient and posts to Slack", async () => {
    const sent: Array<{ to: string; subject: string; html: string }> = [];
    const result = await runSlowQueryDigestJob({
      ...baseOptions,
      recipients: ["db@example.com", "ops@example.com"],
      send: async (to, subject, html) => {
        sent.push({ to, subject, html });
        return true;
      },
    });

    expect(result).toEqual({ patterns: 3, sent: 2, failed: 0, slackSent: true });
    expect(sent.map((s) => s.to)).toEqual(["db@example.com", "ops@example.com"]);
    expect(sent[0].subject).toContain("Slow Query Digest");
    expect(sent[0].html).toContain("A.findMany");
  });

  it("counts failed deliveries without throwing", async () => {
    const result = await runSlowQueryDigestJob({
      ...baseOptions,
      recipients: ["ok@example.com", "bad@example.com"],
      send: async (to) => to === "ok@example.com",
    });

    expect(result).toEqual({ patterns: 3, sent: 1, failed: 1, slackSent: true });
  });

  it("skips delivery when there are no slow queries", async () => {
    let emailed = false;
    let slacked = false;
    const result = await runSlowQueryDigestJob({
      recipients: ["db@example.com"],
      records: [],
      now: () => WINDOW_END,
      send: async () => {
        emailed = true;
        return true;
      },
      sendSlack: async () => {
        slacked = true;
        return true;
      },
    });

    expect(result).toEqual({ patterns: 0, sent: 0, failed: 0, slackSent: false });
    expect(emailed).toBe(false);
    expect(slacked).toBe(false);
  });

  it("reads the window from the injected store when records are not supplied", async () => {
    const findSince = jest.fn().mockResolvedValue(RECORDS);
    const result = await runSlowQueryDigestJob({
      store: { record: jest.fn(), findSince },
      recipients: ["db@example.com"],
      now: () => WINDOW_END,
      windowDays: 7,
      send: async () => true,
      sendSlack: async () => true,
    });

    expect(findSince).toHaveBeenCalledWith(WINDOW_START, WINDOW_END);
    expect(result.patterns).toBe(3);
  });
});
