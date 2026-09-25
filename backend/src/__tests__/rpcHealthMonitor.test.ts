// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  RpcHealthMonitor,
  type RpcHealthAlert,
  type RpcLedgerProbe,
} from "../services/rpcHealthMonitor";

// Silence structured logging during the test run.
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// The default alert sink imports the webhook service (and its Prisma db chain).
// Tests inject their own sink, so stub the module to keep the unit isolated.
jest.mock("../services/webhook", () => ({
  __esModule: true,
  sendWebhook: jest.fn().mockResolvedValue({ success: true, status: 200 }),
}));

const URL_A = "https://rpc-a.example.com";
const URL_B = "https://rpc-b.example.com";

/** Build a healthy probe result anchored at a given ledger. */
function healthyProbe(latest: number, retention = 1000): RpcLedgerProbe {
  return {
    status: "healthy",
    latestLedger: latest,
    oldestLedger: latest - retention,
  };
}

/**
 * A controllable prober: maps each URL to a probe result or an Error to throw.
 * Mutating the map between `checkOnce()` calls simulates nodes going down and
 * recovering.
 */
function makeProber(state: Record<string, RpcLedgerProbe | Error>) {
  return jest.fn(async (url: string): Promise<RpcLedgerProbe> => {
    const outcome = state[url];
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error(`no probe configured for ${url}`);
    return outcome;
  });
}

describe("RpcHealthMonitor", () => {
  it("throws when constructed without any RPC URLs", () => {
    expect(() => new RpcHealthMonitor([])).toThrow(
      "At least one RPC URL must be provided"
    );
  });

  it("reports all nodes healthy and selects the first as active", async () => {
    const alerts: RpcHealthAlert[] = [];
    const monitor = new RpcHealthMonitor([URL_A, URL_B], {
      prober: makeProber({
        [URL_A]: healthyProbe(1000),
        [URL_B]: healthyProbe(1000),
      }),
      alert: (a) => {
        alerts.push(a);
      },
    });

    const nodes = await monitor.checkOnce();

    expect(nodes.every((n) => n.healthy)).toBe(true);
    expect(nodes.every((n) => n.status === "healthy")).toBe(true);
    expect(monitor.getActiveUrl()).toBe(URL_A);
    expect(monitor.getHealthyUrls()).toEqual([URL_A, URL_B]);
    // Steady-state healthy nodes must not spam alerts.
    expect(alerts).toHaveLength(0);
  });

  it("flags a node that lags the best node as a sync delay", async () => {
    const monitor = new RpcHealthMonitor([URL_A, URL_B], {
      prober: makeProber({
        [URL_A]: healthyProbe(1000),
        [URL_B]: healthyProbe(800), // 200 ledgers behind
      }),
      alert: jest.fn(),
      syncLagThreshold: 100,
    });

    const nodes = await monitor.checkOnce();
    const laggard = nodes.find((n) => n.url === URL_B)!;

    expect(laggard.status).toBe("sync_delay");
    expect(laggard.healthy).toBe(false);
    expect(laggard.ledgerLag).toBe(200);
    expect(monitor.getActiveUrl()).toBe(URL_A);
  });

  it("flags a thin retained-ledger window as a ledger history issue", async () => {
    const monitor = new RpcHealthMonitor([URL_A], {
      prober: makeProber({ [URL_A]: healthyProbe(1000, 50) }),
      alert: jest.fn(),
      minLedgerRetention: 100,
    });

    const [node] = await monitor.checkOnce();

    expect(node.status).toBe("ledger_history");
    expect(node.healthy).toBe(false);
  });

  it("flags a node whose RPC self-reports a non-healthy status", async () => {
    const monitor = new RpcHealthMonitor([URL_A], {
      prober: makeProber({
        [URL_A]: { status: "syncing", latestLedger: 900, oldestLedger: 0 },
      }),
      alert: jest.fn(),
    });

    const [node] = await monitor.checkOnce();

    expect(node.status).toBe("ledger_history");
    expect(node.healthy).toBe(false);
  });

  it("detects downtime, alerts, and fails over to a backup node", async () => {
    const alerts: RpcHealthAlert[] = [];
    const state: Record<string, RpcLedgerProbe | Error> = {
      [URL_A]: healthyProbe(1000),
      [URL_B]: healthyProbe(1000),
    };
    const monitor = new RpcHealthMonitor([URL_A, URL_B], {
      prober: makeProber(state),
      alert: (a) => {
        alerts.push(a);
      },
    });

    // First sweep: both healthy, primary active.
    await monitor.checkOnce();
    expect(monitor.getActiveUrl()).toBe(URL_A);
    expect(alerts).toHaveLength(0);

    // Primary goes down.
    state[URL_A] = new Error("connection refused");
    const nodes = await monitor.checkOnce();

    const primary = nodes.find((n) => n.url === URL_A)!;
    expect(primary.status).toBe("down");
    expect(primary.error).toContain("connection refused");

    // Traffic must have failed over to the healthy backup.
    expect(monitor.getActiveUrl()).toBe(URL_B);

    // Both an unhealthy alert and a failover alert must have fired.
    const unhealthy = alerts.find((a) => a.type === "unhealthy");
    const failover = alerts.find((a) => a.type === "failover");
    expect(unhealthy?.url).toBe(URL_A);
    expect(failover?.activeUrl).toBe(URL_B);
  });

  it("emits a recovered alert when a downed node comes back", async () => {
    const alerts: RpcHealthAlert[] = [];
    const state: Record<string, RpcLedgerProbe | Error> = {
      [URL_A]: new Error("timeout"),
    };
    const monitor = new RpcHealthMonitor([URL_A], {
      prober: makeProber(state),
      alert: (a) => {
        alerts.push(a);
      },
    });

    // First sweep: node down, no active node available.
    await monitor.checkOnce();
    expect(monitor.getActiveUrl()).toBeNull();
    expect(alerts.some((a) => a.type === "unhealthy")).toBe(true);

    // Node recovers.
    state[URL_A] = healthyProbe(1000);
    await monitor.checkOnce();

    expect(monitor.getActiveUrl()).toBe(URL_A);
    expect(alerts.some((a) => a.type === "recovered")).toBe(true);
  });

  it("does not fire duplicate alerts while a node stays in the same state", async () => {
    const alert = jest.fn();
    const state: Record<string, RpcLedgerProbe | Error> = {
      [URL_A]: new Error("down"),
    };
    const monitor = new RpcHealthMonitor([URL_A], {
      prober: makeProber(state),
      alert,
    });

    await monitor.checkOnce(); // transition healthy(unknown) -> down: 1 alert
    await monitor.checkOnce(); // still down: no new alert
    await monitor.checkOnce(); // still down: no new alert

    expect(alert).toHaveBeenCalledTimes(1);
  });
});
