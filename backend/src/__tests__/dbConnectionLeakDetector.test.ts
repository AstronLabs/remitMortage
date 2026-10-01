// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();
jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: (...args: unknown[]) => loggerWarnMock(...args),
    error: (...args: unknown[]) => loggerErrorMock(...args),
    debug: jest.fn(),
  },
}));

import { metricsRegistry } from "../services/metrics.js";
import {
  createLeakDetectorExtension,
  getActiveCheckoutCount,
  getActiveCheckouts,
  getLeakThresholdMs,
  getSweepIntervalMs,
  recordCheckout,
  releaseCheckout,
  runSweep,
  startLeakDetector,
  stopLeakDetector,
} from "../services/dbConnectionLeakDetector.js";

/** Read a single gauge/counter value out of the shared registry. */
async function metricValue(name: string, labels?: Record<string, string>): Promise<number | undefined> {
  const metric = await metricsRegistry.getSingleMetricAsString(name);
  const lines = metric.split("\n").filter((l) => l.startsWith(name) && !l.startsWith(`${name}_`));
  const line = labels
    ? lines.find((l) => Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)))
    : lines[0];
  if (!line) return undefined;
  return Number(line.slice(line.lastIndexOf(" ") + 1));
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  stopLeakDetector();
  jest.restoreAllMocks();
  loggerWarnMock.mockClear();
  loggerErrorMock.mockClear();
  process.env = { ...ORIGINAL_ENV };
  delete process.env.DB_CONNECTION_LEAK_THRESHOLD_MS;
  delete process.env.DB_LEAK_SWEEP_INTERVAL_MS;
  delete process.env.DB_LEAK_DETECTION_CAPTURE_STACK;
});

afterEach(() => {
  stopLeakDetector();
  jest.useRealTimers();
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("getLeakThresholdMs / getSweepIntervalMs", () => {
  it("default to 30s threshold and 10s sweep interval when unset", () => {
    expect(getLeakThresholdMs()).toBe(30_000);
    expect(getSweepIntervalMs()).toBe(10_000);
  });

  it("read configured overrides", () => {
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "5000";
    process.env.DB_LEAK_SWEEP_INTERVAL_MS = "1000";
    expect(getLeakThresholdMs()).toBe(5000);
    expect(getSweepIntervalMs()).toBe(1000);
  });

  it.each([["0"], ["-1"], ["abc"], [""]])(
    "falls back to the default for invalid value %p",
    (value) => {
      process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = value;
      process.env.DB_LEAK_SWEEP_INTERVAL_MS = value;
      expect(getLeakThresholdMs()).toBe(30_000);
      expect(getSweepIntervalMs()).toBe(10_000);
    }
  );
});

describe("recordCheckout / releaseCheckout", () => {
  it("tracks a checkout until it is released", () => {
    const id = recordCheckout("Borrower", "findMany");
    expect(getActiveCheckoutCount()).toBe(1);

    const [record] = getActiveCheckouts();
    expect(record.id).toBe(id);
    expect(record.model).toBe("Borrower");
    expect(record.operation).toBe("findMany");
    expect(record.alreadyFlagged).toBe(false);

    releaseCheckout(id);
    expect(getActiveCheckoutCount()).toBe(0);
  });

  it("is a no-op to release an unknown id", () => {
    recordCheckout("Loan", "create");
    expect(() => releaseCheckout("not-a-real-id")).not.toThrow();
    expect(getActiveCheckoutCount()).toBe(1);
  });

  it("captures a call stack by default", () => {
    const id = recordCheckout("Borrower", "findMany");
    const [record] = getActiveCheckouts();
    expect(record.stack).toEqual(expect.any(String));
    releaseCheckout(id);
  });

  it("omits the stack when capture is disabled", () => {
    process.env.DB_LEAK_DETECTION_CAPTURE_STACK = "false";
    const id = recordCheckout("Borrower", "findMany");
    const [record] = getActiveCheckouts();
    expect(record.stack).toBeNull();
    releaseCheckout(id);
  });

  it("refreshes the long-held gauge to zero once every over-threshold checkout is released", async () => {
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "100";
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    const id = recordCheckout("Borrower", "findMany");

    jest.spyOn(Date, "now").mockReturnValue(now + 200);
    runSweep();
    await expect(metricValue("remitmortgage_db_pool_long_held_connections")).resolves.toBe(1);

    releaseCheckout(id);
    await expect(metricValue("remitmortgage_db_pool_long_held_connections")).resolves.toBe(0);
  });
});

describe("runSweep", () => {
  it("does not flag a checkout younger than the threshold", async () => {
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "30000";
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    recordCheckout("Borrower", "findMany");

    jest.spyOn(Date, "now").mockReturnValue(now + 1000);
    runSweep();

    expect(loggerWarnMock).not.toHaveBeenCalled();
    await expect(metricValue("remitmortgage_db_pool_long_held_connections")).resolves.toBe(0);
  });

  it("flags a checkout that has exceeded the threshold with a WARN log and metric increments", async () => {
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "1000";
    const labels = { model: "LoanApplication", operation: "update" };
    const before = (await metricValue("remitmortgage_db_pool_leak_events_total", labels)) ?? 0;

    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    recordCheckout(labels.model, labels.operation);

    jest.spyOn(Date, "now").mockReturnValue(now + 5000);
    runSweep();

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "[db-leak] Long-held database connection detected",
      expect.objectContaining({
        model: labels.model,
        operation: labels.operation,
        ageMs: 5000,
        thresholdMs: 1000,
      })
    );

    await expect(metricValue("remitmortgage_db_pool_long_held_connections")).resolves.toBe(1);
    await expect(
      metricValue("remitmortgage_db_pool_leak_events_total", labels)
    ).resolves.toBe(before + 1);
  });

  it("logs a lower-noise reminder (not a new leak event) on repeated sweeps of the same checkout", async () => {
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "1000";
    const labels = { model: "Borrower", operation: "findMany" };
    const before = (await metricValue("remitmortgage_db_pool_leak_events_total", labels)) ?? 0;

    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    recordCheckout(labels.model, labels.operation);

    jest.spyOn(Date, "now").mockReturnValue(now + 2000);
    runSweep();
    jest.spyOn(Date, "now").mockReturnValue(now + 4000);
    runSweep();

    // Flagged once (first sweep) + one repeat reminder (second sweep).
    expect(loggerWarnMock).toHaveBeenCalledTimes(2);
    expect(loggerWarnMock.mock.calls[0][0]).toBe(
      "[db-leak] Long-held database connection detected"
    );
    expect(loggerWarnMock.mock.calls[1][0]).toBe(
      "[db-leak] Long-held connection still open (repeated)"
    );

    // The counter must not double-increment for the same still-open checkout.
    await expect(
      metricValue("remitmortgage_db_pool_leak_events_total", labels)
    ).resolves.toBe(before + 1);
  });

  it("counts multiple distinct over-threshold checkouts in the gauge", async () => {
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "1000";
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now);
    recordCheckout("Borrower", "findMany");
    recordCheckout("Loan", "create");

    jest.spyOn(Date, "now").mockReturnValue(now + 5000);
    runSweep();

    await expect(metricValue("remitmortgage_db_pool_long_held_connections")).resolves.toBe(2);
  });
});

describe("startLeakDetector / stopLeakDetector", () => {
  it("runs sweeps on the configured interval", () => {
    jest.useFakeTimers();
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "500";
    recordCheckout("Borrower", "findMany");

    startLeakDetector(1000);
    // The fake clock and the timer share the same underlying clock, so
    // advancing 1000ms both fires the sweep and ages the checkout past the
    // 500ms threshold.
    jest.advanceTimersByTime(1000);

    expect(loggerWarnMock).toHaveBeenCalledTimes(1);
  });

  it("is a no-op to start a second time while already running", () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, "setInterval");

    startLeakDetector(1000);
    startLeakDetector(500);

    // A second `setInterval` registration would mean two sweepers running
    // concurrently and double-logging every leak.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("clears all tracked checkouts and resets the gauge on stop", async () => {
    recordCheckout("Borrower", "findMany");
    expect(getActiveCheckoutCount()).toBe(1);

    stopLeakDetector();

    expect(getActiveCheckoutCount()).toBe(0);
    await expect(metricValue("remitmortgage_db_pool_long_held_connections")).resolves.toBe(0);
  });

  it("swallows a sweep error instead of crashing the interval", () => {
    jest.useFakeTimers();
    process.env.DB_CONNECTION_LEAK_THRESHOLD_MS = "500";
    loggerWarnMock.mockImplementationOnce(() => {
      throw new Error("log sink down");
    });
    recordCheckout("Borrower", "findMany");

    startLeakDetector(1000);
    expect(() => jest.advanceTimersByTime(1000)).not.toThrow();

    expect(loggerErrorMock).toHaveBeenCalledWith(
      "[db-leak] Sweep error",
      expect.objectContaining({ err: expect.any(Error) })
    );
  });
});

describe("createLeakDetectorExtension", () => {
  it("passes the operation through and releases the checkout on success", async () => {
    const extension = createLeakDetectorExtension();
    const query = jest.fn().mockResolvedValue([{ id: "1" }]);

    const result = await extension.query.$allModels.$allOperations({
      model: "Borrower",
      operation: "findMany",
      args: { where: {} },
      query,
    });

    expect(result).toEqual([{ id: "1" }]);
    expect(query).toHaveBeenCalledWith({ where: {} });
    expect(getActiveCheckoutCount()).toBe(0);
  });

  it("releases the checkout even when the operation rejects", async () => {
    const extension = createLeakDetectorExtension();
    const failure = new Error("query failed");

    await expect(
      extension.query.$allModels.$allOperations({
        model: "Borrower",
        operation: "findMany",
        args: {},
        query: jest.fn().mockRejectedValue(failure),
      })
    ).rejects.toBe(failure);

    // A leaked checkout entry here would permanently skew the leak gauge
    // upward for an operation that already failed and released its slot.
    expect(getActiveCheckoutCount()).toBe(0);
  });

  it("labels raw queries with model \"raw\" when no model is given", async () => {
    const extension = createLeakDetectorExtension();
    let capturedDuringQuery = 0;

    await extension.query.$allModels.$allOperations({
      model: undefined,
      operation: "queryRaw",
      args: {},
      query: async () => {
        capturedDuringQuery = getActiveCheckoutCount();
        const [record] = getActiveCheckouts();
        expect(record.model).toBe("raw");
        expect(record.operation).toBe("queryRaw");
        return [];
      },
    });

    expect(capturedDuringQuery).toBe(1);
    expect(getActiveCheckoutCount()).toBe(0);
  });
});

describe("metrics exposition", () => {
  it("registers the leak-detection metrics on the shared registry", async () => {
    const exposition = await metricsRegistry.metrics();
    expect(exposition).toContain("remitmortgage_db_pool_long_held_connections");
    expect(exposition).toContain("remitmortgage_db_pool_leak_events_total");
  });
});
