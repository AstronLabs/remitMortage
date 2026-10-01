// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for automated unused-index detection (issue #758).
 *
 * Acceptance criteria under test:
 * 1. A scheduled report identifies indexes with sustained near-zero usage as
 *    removal candidates (with table/columns/size/last-used context).
 * 2. Constraint-backing indexes (primary key / unique) are NEVER flagged for
 *    removal, regardless of observed scan activity.
 */

import {
  buildUnusedIndexReport,
  findUnusedIndexCandidates,
  type IndexUsageStat,
} from "../services/unusedIndexAudit.js";
import { runUnusedIndexAuditJob } from "../jobs/unusedIndexAudit.js";

jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: jest.fn((_title: string, body: string) => `<html>${body}</html>`),
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    complianceAlertEmail: "dba@remitmortgage.com",
  })),
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

function stat(overrides: Partial<IndexUsageStat> = {}): IndexUsageStat {
  return {
    table: "public.LoanApplication",
    indexName: "LoanApplication_status_idx",
    columns: ["status"],
    scans: 0,
    tuplesRead: 0,
    sizeBytes: 1024 * 512,
    lastUsedAt: null,
    observedForDays: 30,
    isConstraintBacked: false,
    ...overrides,
  };
}

describe("findUnusedIndexCandidates (issue #758)", () => {
  it("flags an index with sustained zero scans as a removal candidate with context", () => {
    const stats = [
      stat({
        indexName: "LoanApplication_status_createdAt_idx",
        columns: ["status", "createdAt"],
        sizeBytes: 8 * 1024 * 1024,
      }),
    ];
    const candidates = findUnusedIndexCandidates(stats, {
      minObservationDays: 14,
      previousScans: { "LoanApplication_status_createdAt_idx": 0 },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].table).toBe("public.LoanApplication");
    expect(candidates[0].columns).toEqual(["status", "createdAt"]);
    expect(candidates[0].sizeBytes).toBe(8 * 1024 * 1024);
    expect(candidates[0].reason).toContain("zero/negligible scans");
  });

  it("never flags constraint-backing indexes, even with zero scans", () => {
    const stats = [
      stat({ indexName: "Applicant_pkey", isConstraintBacked: true, constraintKind: "PRIMARY KEY", scans: 0 }),
      stat({ indexName: "Applicant_stellarAddress_key", isConstraintBacked: true, constraintKind: "UNIQUE", scans: 0 }),
      stat({ indexName: "InviteCode_code_key", isConstraintBacked: true, scans: 0 }),
    ];
    const candidates = findUnusedIndexCandidates(stats, {
      minObservationDays: 14,
      previousScans: {
        Applicant_pkey: 0,
        Applicant_stellarAddress_key: 0,
        InviteCode_code_key: 0,
      },
    });
    expect(candidates).toHaveLength(0);
  });

  it("ignores indexes under observation for less than the minimum window", () => {
    const candidates = findUnusedIndexCandidates([stat({ observedForDays: 2 })], {
      minObservationDays: 14,
      previousScans: { [stat().indexName]: 0 },
    });
    expect(candidates).toHaveLength(0);
  });

  it("requires sustained idleness: a recently-used index is not a candidate", () => {
    const single = findUnusedIndexCandidates([stat({ scans: 120 })], { minObservationDays: 14 });
    expect(single).toHaveLength(0);

    const regressed = findUnusedIndexCandidates([stat({ scans: 5 })], {
      minObservationDays: 14,
      previousScans: { [stat().indexName]: 0 },
    });
    expect(regressed).toHaveLength(0);
  });

  it("builds a report that lists excluded constraint indexes separately", () => {
    const stats = [
      stat({ indexName: "stale_feature_flag_idx", columns: ["flag"] }),
      stat({ indexName: "Applicant_pkey", isConstraintBacked: true, constraintKind: "PRIMARY KEY" }),
    ];
    const candidates = findUnusedIndexCandidates(stats, {
      minObservationDays: 14,
      requiredIdleObservations: 1,
    });
    const report = buildUnusedIndexReport(stats, candidates, 14);
    expect(report.candidates.map((c) => c.indexName)).toEqual(["stale_feature_flag_idx"]);
    expect(report.excludedConstraintIndexes).toEqual(["Applicant_pkey"]);
    expect(report.totalReclaimableBytes).toBeGreaterThan(0);
  });
});

describe("runUnusedIndexAuditJob (issue #758)", () => {
  const tmpSnapshot = `/tmp/unused-index-snapshot-${process.pid}.json`;

  it("emails a scheduled report for sustained-idle indexes and persists a snapshot", async () => {
    const { sendEmail } = jest.requireMock("../services/email.js") as { sendEmail: jest.Mock };
    sendEmail.mockClear();
    const { report, emailed } = await runUnusedIndexAuditJob({
      fetchStats: async () => [
        stat({ indexName: "leftover_feature_idx", observedForDays: 30, sizeBytes: 1024 * 1024 }),
        stat({ indexName: "Applicant_pkey", isConstraintBacked: true, constraintKind: "PRIMARY KEY" }),
      ],
      recipients: ["dba@remitmortgage.com"],
      snapshotFile: tmpSnapshot,
    });
    expect(report.candidates.map((c) => c.indexName)).toEqual(["leftover_feature_idx"]);
    expect(report.excludedConstraintIndexes).toEqual(["Applicant_pkey"]);
    expect(emailed).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("sends nothing when there are no candidates", async () => {
    const { sendEmail } = jest.requireMock("../services/email.js") as { sendEmail: jest.Mock };
    sendEmail.mockClear();
    const { report, emailed } = await runUnusedIndexAuditJob({
      fetchStats: async () => [stat({ indexName: "hot_path_idx", scans: 5000 })],
      recipients: ["dba@remitmortgage.com"],
      snapshotFile: `${tmpSnapshot}-empty`,
    });
    expect(report.candidates).toHaveLength(0);
    expect(emailed).toBe(0);
  });
});
