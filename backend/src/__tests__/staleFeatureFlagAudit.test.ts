// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the stale feature-flag cleanup audit (issue #754).
 *
 * Acceptance criteria under test:
 * 1. A flag stuck at 100% or 0% rollout for the configured duration is
 *    surfaced as a cleanup candidate.
 * 2. The audit distinguishes a stale-but-still-referenced flag from one
 *    that's already orphaned in code.
 */

import { findStaleFlagCandidates } from "../services/featureFlagAudit.js";
import { runStaleFeatureFlagAuditJob } from "../jobs/staleFeatureFlagAudit.js";

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: jest.fn((_title: string, body: string) => `<html>${body}</html>`),
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({ complianceAlertEmail: "team@remitmortgage.com" })),
}));

jest.mock("../services/db.js", () => ({
  prisma: { auditLog: { create: jest.fn().mockResolvedValue({}) } },
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../services/issueNotifier.js", () => ({
  createIssueNotifier: jest.fn(() => ({ open: jest.fn().mockResolvedValue(undefined) })),
}));

const NOW = new Date("2026-09-28T00:00:00.000Z");
const oldDate = "2026-06-01T00:00:00.000Z";
const recentDate = "2026-09-20T00:00:00.000Z";

describe("findStaleFlagCandidates", () => {
  it("flags 100% rollout without variants sustained 30+ days", () => {
    const out = findStaleFlagCandidates(
      [{ key: "a", description: "a", owner: "t", rolloutPercent: 100, hasVariants: false, lastChangedAt: oldDate }],
      { now: NOW }
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("rolled-out");
  });

  it("flags 0% rollout sustained 30+ days", () => {
    const out = findStaleFlagCandidates(
      [{ key: "b", description: "b", owner: "t", rolloutPercent: 0, hasVariants: false, lastChangedAt: oldDate }],
      { now: NOW }
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("killed");
  });

  it("ignores mid-rollout, variant-gated, and recently changed flags", () => {
    const out = findStaleFlagCandidates(
      [
        { key: "mid", description: "m", owner: "t", rolloutPercent: 45, hasVariants: true, lastChangedAt: oldDate },
        { key: "var", description: "v", owner: "t", rolloutPercent: 100, hasVariants: true, lastChangedAt: oldDate },
        { key: "new", description: "n", owner: "t", rolloutPercent: 100, hasVariants: false, lastChangedAt: recentDate },
      ],
      { now: NOW }
    );
    expect(out).toHaveLength(0);
  });
});

describe("runStaleFeatureFlagAuditJob", () => {
  it("distinguishes stale-referenced from stale-orphaned flags and opens one issue per flag", async () => {
    const opened: string[] = [];
    const result = await runStaleFeatureFlagAuditJob({
      now: new Date("2026-09-28T00:00:00.000Z"),
      minStaleDays: 30,
      findReferences: async (key: string) =>
        key === "new-repayment-schedule" ? ["frontend/src/app/page.tsx"] : [],
      recipients: [],
      issueSink: {
        open: async (issue) => {
          opened.push(issue.title);
        },
      },
    });
    // Registry has 2 stale flags (100% + 0%), 1 mid-rollout excluded.
    expect(result.entries).toHaveLength(2);
    const byKey = Object.fromEntries(result.entries.map((e) => [e.flag.key, e.codeStatus]));
    expect(byKey["new-repayment-schedule"]).toBe("stale-referenced");
    expect(byKey["legacy-kyc-fallback"]).toBe("stale-orphaned");
    expect(opened).toHaveLength(2);
  });
});
