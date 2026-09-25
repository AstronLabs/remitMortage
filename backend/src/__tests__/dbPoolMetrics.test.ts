// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { metricsRegistry } from "../services/metrics.js";
import {
  DB_POOL_DEFAULTS,
  buildDatabaseUrl,
  resolvePoolSettings,
} from "../services/dbPoolConfig.js";
import {
  POOL_TIMEOUT_CODE,
  createDbPoolMetricsExtension,
  getInFlightCount,
  getTrackedConnectionLimit,
  initDbPoolMetrics,
  resetDbPoolMetricsState,
  trackDbOperation,
} from "../services/dbPoolMetrics.js";

/** Read a single gauge/counter value out of the shared registry. */
async function metricValue(name: string): Promise<number | undefined> {
  const metric = await metricsRegistry.getSingleMetricAsString(name);
  const line = metric
    .split("\n")
    .find((l) => l.startsWith(name) && !l.startsWith(`${name}_`));
  if (!line) return undefined;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

/** A promise plus the handles to settle it, for holding operations in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  initDbPoolMetrics({ DB_CONNECTION_LIMIT: "10" } as NodeJS.ProcessEnv);
  resetDbPoolMetricsState();
});

describe("resolvePoolSettings", () => {
  it("falls back to the documented defaults when unset", () => {
    expect(resolvePoolSettings({} as NodeJS.ProcessEnv)).toEqual(DB_POOL_DEFAULTS);
  });

  it("reads the configured values", () => {
    expect(
      resolvePoolSettings({
        DB_CONNECTION_LIMIT: "42",
        DB_POOL_TIMEOUT: "5",
        DB_CONNECT_TIMEOUT: "7",
      } as NodeJS.ProcessEnv)
    ).toEqual({ connectionLimit: 42, poolTimeout: 5, connectTimeout: 7 });
  });

  it.each([["0"], ["-1"], ["abc"], [""]])(
    "rejects the invalid limit %p and keeps the default",
    (value) => {
      expect(
        resolvePoolSettings({ DB_CONNECTION_LIMIT: value } as NodeJS.ProcessEnv)
          .connectionLimit
      ).toBe(DB_POOL_DEFAULTS.connectionLimit);
    }
  );
});

describe("buildDatabaseUrl", () => {
  it("returns undefined without a base URL", () => {
    expect(buildDatabaseUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it("appends pool parameters with ? when the URL has no query string", () => {
    const url = buildDatabaseUrl({
      DATABASE_URL: "postgres://user:pw@host:5432/db",
      DB_CONNECTION_LIMIT: "30",
    } as NodeJS.ProcessEnv);

    expect(url).toContain("?connection_limit=30");
    expect(url).toContain("&pool_timeout=15");
    expect(url).toContain("&connect_timeout=30");
  });

  it("appends with & when the URL already has a query string", () => {
    const url = buildDatabaseUrl({
      DATABASE_URL: "postgres://user:pw@host:5432/db?sslmode=require",
    } as NodeJS.ProcessEnv);

    expect(url).toContain("?sslmode=require&connection_limit=");
  });
});

describe("pool utilization gauges", () => {
  it("publishes the configured maximum", async () => {
    expect(getTrackedConnectionLimit()).toBe(10);
    await expect(metricValue("remitmortgage_db_pool_max_connections")).resolves.toBe(10);
  });

  it("starts idle", async () => {
    await expect(
      metricValue("remitmortgage_db_pool_utilization_ratio")
    ).resolves.toBe(0);
    await expect(
      metricValue("remitmortgage_db_pool_queued_queries")
    ).resolves.toBe(0);
  });

  it("tracks utilization while operations are in flight", async () => {
    const gate = deferred();

    // Hold 5 of 10 connections.
    const running = Array.from({ length: 5 }, () =>
      trackDbOperation({ model: "Borrower", operation: "findMany" }, () => gate.promise)
    );

    expect(getInFlightCount()).toBe(5);
    await expect(
      metricValue("remitmortgage_db_pool_utilization_ratio")
    ).resolves.toBeCloseTo(0.5);
    await expect(
      metricValue("remitmortgage_db_pool_queued_queries")
    ).resolves.toBe(0);

    gate.resolve();
    await Promise.all(running);

    expect(getInFlightCount()).toBe(0);
    await expect(
      metricValue("remitmortgage_db_pool_utilization_ratio")
    ).resolves.toBe(0);
  });

  it("clamps utilization at 1 and reports the excess as queued", async () => {
    const gate = deferred();

    // 14 operations against a pool of 10 → 4 waiting.
    const running = Array.from({ length: 14 }, () =>
      trackDbOperation({ model: "Borrower", operation: "findMany" }, () => gate.promise)
    );

    await expect(
      metricValue("remitmortgage_db_pool_utilization_ratio")
    ).resolves.toBe(1);
    await expect(
      metricValue("remitmortgage_db_pool_queued_queries")
    ).resolves.toBe(4);

    gate.resolve();
    await Promise.all(running);
  });

  it("records the peak and holds it after load drops", async () => {
    const gate = deferred();
    const running = Array.from({ length: 8 }, () =>
      trackDbOperation({ model: "Loan", operation: "findFirst" }, () => gate.promise)
    );

    gate.resolve();
    await Promise.all(running);

    await expect(
      metricValue("remitmortgage_db_pool_peak_in_flight_queries")
    ).resolves.toBe(8);
    await expect(
      metricValue("remitmortgage_db_pool_in_flight_queries")
    ).resolves.toBe(0);
  });
});

describe("failure accounting", () => {
  it("releases the in-flight slot when an operation rejects", async () => {
    // A leaked slot would strand the gauge high and page ops for an idle pool.
    await expect(
      trackDbOperation({ model: "Borrower", operation: "create" }, () =>
        Promise.reject(new Error("boom"))
      )
    ).rejects.toThrow("boom");

    expect(getInFlightCount()).toBe(0);
    await expect(
      metricValue("remitmortgage_db_pool_utilization_ratio")
    ).resolves.toBe(0);
  });

  it("counts pool acquisition timeouts separately", async () => {
    const before = (await metricValue("remitmortgage_db_pool_timeouts_total")) ?? 0;

    const timeout = Object.assign(new Error("pool timeout"), {
      code: POOL_TIMEOUT_CODE,
    });
    await expect(
      trackDbOperation({ model: "Borrower", operation: "findMany" }, () =>
        Promise.reject(timeout)
      )
    ).rejects.toBe(timeout);

    await expect(
      metricValue("remitmortgage_db_pool_timeouts_total")
    ).resolves.toBe(before + 1);
  });

  it("does not count unrelated failures as pool timeouts", async () => {
    const before = (await metricValue("remitmortgage_db_pool_timeouts_total")) ?? 0;

    const conflict = Object.assign(new Error("unique constraint"), {
      code: "P2002",
    });
    await expect(
      trackDbOperation({ model: "Borrower", operation: "create" }, () =>
        Promise.reject(conflict)
      )
    ).rejects.toBe(conflict);

    await expect(
      metricValue("remitmortgage_db_pool_timeouts_total")
    ).resolves.toBe(before);
  });

  it("re-throws the original error untouched", async () => {
    const original = new Error("original");
    await expect(
      trackDbOperation({}, () => Promise.reject(original))
    ).rejects.toBe(original);
  });
});

describe("prisma client extension", () => {
  it("passes the operation through and records it", async () => {
    const extension = createDbPoolMetricsExtension();
    const query = jest.fn().mockResolvedValue([{ id: "1" }]);

    const result = await extension.query.$allModels.$allOperations({
      model: "Borrower",
      operation: "findMany",
      args: { where: {} },
      query,
    });

    expect(result).toEqual([{ id: "1" }]);
    expect(query).toHaveBeenCalledWith({ where: {} });
    expect(getInFlightCount()).toBe(0);
  });

  it("propagates rejections without swallowing them", async () => {
    const extension = createDbPoolMetricsExtension();
    const failure = new Error("query failed");

    await expect(
      extension.query.$allModels.$allOperations({
        model: "Borrower",
        operation: "findMany",
        args: {},
        query: jest.fn().mockRejectedValue(failure),
      })
    ).rejects.toBe(failure);

    expect(getInFlightCount()).toBe(0);
  });
});

describe("metrics exposition", () => {
  it("registers every pool metric on the shared registry", async () => {
    const exposition = await metricsRegistry.metrics();

    for (const name of [
      "remitmortgage_db_pool_max_connections",
      "remitmortgage_db_pool_in_flight_queries",
      "remitmortgage_db_pool_utilization_ratio",
      "remitmortgage_db_pool_queued_queries",
      "remitmortgage_db_pool_peak_in_flight_queries",
      "remitmortgage_db_query_duration_seconds",
      "remitmortgage_db_pool_timeouts_total",
      "remitmortgage_db_query_errors_total",
    ]) {
      expect(exposition).toContain(name);
    }
  });
});
