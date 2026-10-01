// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Automated long-running query killer (issue #736).
 * A query past the threshold is terminated; every termination is logged with
 * origin context; allowlisted maintenance jobs are never terminated.
 */

import {
  runQueryKillerJob,
  selectQueriesToKill,
  isAllowlisted,
  type LongRunningQuery,
} from "../jobs/queryKiller.js";

function row(overrides: Partial<LongRunningQuery> = {}): LongRunningQuery {
  return {
    pid: 1234,
    durationMs: 600_000,
    state: "active",
    query: "SELECT * FROM LoanApplication", // missing WHERE — runaway
    usename: "app",
    applicationName: "remit-api",
    clientAddr: "10.0.0.5",
    waitEventType: null,
    waitEvent: null,
    xactStart: new Date(),
    queryStart: new Date(),
    ...overrides,
  };
}

describe("long-running query killer (issue #736)", () => {
  it("terminates a query running past the threshold with full origin context", async () => {
    const terminated: number[] = [];
    const alerts: any[] = [];
    const result = await runQueryKillerJob({
      thresholdMs: 300_000,
      findCandidates: async () => [row({ pid: 111, durationMs: 900_000, query: "SELECT * FROM Borrower" })],
      terminate: async (pid) => {
        terminated.push(pid);
        return true;
      },
      alert: async (killed, thresholdMs) => {
        alerts.push({ killed, thresholdMs });
      },
    });
    expect(result.killed).toBe(1);
    expect(result.killedPids).toEqual([111]);
    expect(terminated).toEqual([111]);
    // Logged with enough detail to identify origin.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].killed.query).toMatch(/Borrower/);
    expect(alerts[0].killed.clientAddr).toBe("10.0.0.5");
    expect(alerts[0].thresholdMs).toBe(300_000);
  });

  it("never terminates an allowlisted maintenance job", async () => {
    const terminated: number[] = [];
    const result = await runQueryKillerJob({
      thresholdMs: 60_000,
      findCandidates: async () => [
        row({ pid: 222, durationMs: 3_600_000, query: "VACUUM ANALYZE LoanApplication", applicationName: "partition_manager" }),
        row({ pid: 333, durationMs: 3_600_000, query: "SELECT pg_sleep(10000)" }),
      ],
      terminate: async (pid) => {
        terminated.push(pid);
        return true;
      },
      alert: async () => {},
    });
    expect(terminated).toEqual([333]);
    expect(result.killed).toBe(1);
    expect(result.skippedAllowlisted).toBe(1);
    expect(isAllowlisted("VACUUM ANALYZE t", "partition_manager")).toBe(true);
  });

  it("leaves fast queries alone", async () => {
    const picked = selectQueriesToKill([row({ durationMs: 1_000 })], 300_000);
    expect(picked).toHaveLength(0);
  });
});
