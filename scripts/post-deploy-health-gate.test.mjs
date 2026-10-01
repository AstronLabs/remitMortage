// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  accumulateDelta,
  buildAlertPayload,
  configFromEnv,
  decideAction,
  isTruthy,
  parseHttpRequestCounts,
  runAlertCommand,
  runGateCommand,
  runHealthGate,
} from "./post-deploy-health-gate.mjs";

const HEALTH_URL = "https://svc.example.com/api/health";
const METRICS_URL = "https://svc.example.com/metrics";

function metricsText(ok, serverErrors) {
  return [
    "# HELP remitmortgage_http_requests_total Total number of HTTP requests received.",
    "# TYPE remitmortgage_http_requests_total counter",
    `remitmortgage_http_requests_total{method="GET",route="/api/loan",status_code="200"} ${ok}`,
    `remitmortgage_http_requests_total{method="POST",route="/api/loan",status_code="500"} ${serverErrors}`,
    'remitmortgage_other_total{status_code="500"} 999',
    "",
  ].join("\n");
}

/** Deterministic clock: sleeping advances time, nothing really waits. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

function response(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const baseConfig = {
  healthUrl: HEALTH_URL,
  metricsUrl: null,
  metricsToken: null,
  windowMs: 60_000,
  intervalMs: 10_000,
  requestTimeoutMs: 1_000,
  maxConsecutiveHealthFailures: 3,
  maxErrorRate: 0.05,
  minRequests: 20,
};

test("parseHttpRequestCounts splits total from 5xx and ignores other metrics", () => {
  assert.deepEqual(parseHttpRequestCounts(metricsText(90, 10)), { total: 100, errors: 10 });
  assert.deepEqual(parseHttpRequestCounts("# nothing here\n"), { total: 0, errors: 0 });
});

test("accumulateDelta adds deltas and treats a counter reset as a restart", () => {
  let acc = accumulateDelta({ requests: 0, errors: 0 }, { total: 100, errors: 4 }, { total: 130, errors: 6 });
  assert.deepEqual(acc, { requests: 30, errors: 2 });
  // Counter went backwards: the process restarted, so the new value is the delta.
  acc = accumulateDelta(acc, { total: 130, errors: 6 }, { total: 12, errors: 1 });
  assert.deepEqual(acc, { requests: 42, errors: 3 });
});

test("passes when every check in the window is healthy", async () => {
  const clock = fakeClock();
  const report = await runHealthGate(baseConfig, {
    fetch: async () => response(200),
    ...clock,
  });
  assert.equal(report.passed, true);
  assert.equal(report.failure, null);
  assert.ok(report.healthChecks.total >= 6);
  assert.equal(report.healthChecks.failed, 0);
});

test("a single health blip does not fail the gate", async () => {
  const clock = fakeClock();
  let calls = 0;
  const report = await runHealthGate(baseConfig, {
    fetch: async () => response(++calls === 2 ? 503 : 200),
    ...clock,
  });
  assert.equal(report.passed, true);
  assert.equal(report.healthChecks.failed, 1);
});

test("fails fast after consecutive health failures, capturing diagnostics", async () => {
  const clock = fakeClock();
  const report = await runHealthGate(baseConfig, {
    fetch: async () => response(503, '{"status":"degraded","components":{"database":{"status":"unhealthy"}}}'),
    ...clock,
  });

  assert.equal(report.passed, false);
  assert.equal(report.failure.signal, "health_check_failed");
  assert.equal(report.healthChecks.consecutiveFailures, 3);
  assert.equal(report.healthChecks.lastStatus, 503);
  assert.match(report.healthChecks.lastBody, /database/);
  // Failed as soon as the threshold was hit, not after the full window.
  assert.ok(report.durationMs < baseConfig.windowMs);
});

test("an unreachable or timing-out endpoint counts as a failed check", async () => {
  const clock = fakeClock();
  const report = await runHealthGate(baseConfig, {
    fetch: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    ...clock,
  });
  assert.equal(report.passed, false);
  assert.equal(report.failure.signal, "health_check_failed");
  assert.match(report.healthChecks.lastError, /ECONNREFUSED/);
});

test("fails on an error rate above the threshold once enough requests were seen", async () => {
  const clock = fakeClock();
  // Each scrape adds 100 requests, 20 of them 5xx (20% > 5%).
  let scrapes = 0;
  const report = await runHealthGate(
    { ...baseConfig, metricsUrl: METRICS_URL },
    {
      fetch: async (url) => {
        if (url === METRICS_URL) {
          scrapes += 1;
          return response(200, metricsText(scrapes * 80, scrapes * 20));
        }
        return response(200);
      },
      ...clock,
    }
  );

  assert.equal(report.passed, false);
  assert.equal(report.failure.signal, "error_rate_exceeded");
  assert.equal(report.errorRate.available, true);
  assert.ok(report.errorRate.rate > 0.05);
  assert.ok(report.errorRate.requests >= 20);
});

test("a high error rate on too few requests does not fail the gate", async () => {
  const clock = fakeClock();
  let scrapes = 0;
  // Baseline + polls add just 5 requests total, all errors.
  const report = await runHealthGate(
    { ...baseConfig, metricsUrl: METRICS_URL, minRequests: 20 },
    {
      fetch: async (url) => {
        if (url === METRICS_URL) {
          scrapes += 1;
          return response(200, metricsText(0, Math.min(scrapes - 1, 5)));
        }
        return response(200);
      },
      ...clock,
    }
  );
  assert.equal(report.passed, true);
  assert.equal(report.errorRate.rate, 1);
  assert.ok(report.errorRate.requests < 20);
});

test("a low error rate passes", async () => {
  const clock = fakeClock();
  let scrapes = 0;
  const report = await runHealthGate(
    { ...baseConfig, metricsUrl: METRICS_URL },
    {
      fetch: async (url) => {
        if (url === METRICS_URL) {
          scrapes += 1;
          return response(200, metricsText(scrapes * 100, scrapes * 1));
        }
        return response(200);
      },
      ...clock,
    }
  );
  assert.equal(report.passed, true);
  assert.ok(report.errorRate.rate < 0.05);
});

test("an unreachable metrics endpoint degrades to health-only without failing the gate", async () => {
  const clock = fakeClock();
  const report = await runHealthGate(
    { ...baseConfig, metricsUrl: METRICS_URL },
    {
      fetch: async (url) => (url === METRICS_URL ? response(401) : response(200)),
      ...clock,
    }
  );
  assert.equal(report.passed, true);
  assert.equal(report.errorRate.available, false);
});

test("decideAction: failure rolls back unless the manual override is on", () => {
  assert.equal(decideAction({ passed: false, autoRollbackDisabled: false }), "rollback");
  assert.equal(decideAction({ passed: false, autoRollbackDisabled: true }), "alert_only");
  assert.equal(decideAction({ passed: true, autoRollbackDisabled: false }), "none");
  assert.equal(decideAction({ passed: true, autoRollbackDisabled: true }), "none");
});

test("isTruthy accepts the usual spellings and defaults to false", () => {
  for (const v of ["true", "TRUE", "1", "yes"]) assert.equal(isTruthy(v), true);
  for (const v of ["false", "", undefined, "no", "0"]) assert.equal(isTruthy(v), false);
});

test("configFromEnv applies defaults, requires HEALTH_URL, and rejects bad numbers", () => {
  const config = configFromEnv({ HEALTH_URL });
  assert.equal(config.windowMs, 300_000);
  assert.equal(config.maxConsecutiveHealthFailures, 3);
  assert.equal(config.maxErrorRate, 0.05);
  assert.throws(() => configFromEnv({}), /HEALTH_URL/);
  assert.throws(() => configFromEnv({ HEALTH_URL, HEALTH_GATE_MAX_ERROR_RATE: "lots" }), /HEALTH_GATE_MAX_ERROR_RATE/);
});

const failedReport = {
  passed: false,
  failure: { signal: "health_check_failed", message: "Health endpoint failed 3 consecutive checks (last: 503)." },
  durationMs: 40_000,
  windowMs: 300_000,
  healthChecks: {
    total: 4,
    failed: 3,
    consecutiveFailures: 3,
    lastStatus: 503,
    lastError: null,
    lastBody: '{"status":"degraded"}',
  },
  errorRate: { available: true, requests: 200, errors: 40, rate: 0.2, threshold: 0.05, minRequests: 20 },
};

const alertCtx = {
  environment: "production",
  imageTag: "v1.2.3",
  newSlot: "green",
  previousSlot: "blue",
  runUrl: "https://github.com/org/repo/actions/runs/1",
  report: failedReport,
};

test("failure alert carries the signal, health detail, error rate and run link", () => {
  const { text } = buildAlertPayload("failure", alertCtx);
  for (const expected of [
    "production",
    "v1.2.3",
    "health_check_failed",
    "3/4 failed",
    '{"status":"degraded"}',
    "20.0%",
    "actions/runs/1",
    "Automatic rollback is starting",
    "docs/AUTOMATIC_ROLLBACK.md",
  ]) {
    assert.ok(text.includes(expected), `expected alert to include ${expected}\n${text}`);
  }
});

test("failure alert states clearly when the manual override suppressed rollback", () => {
  const { text } = buildAlertPayload("failure", {
    ...alertCtx,
    autoRollbackDisabled: true,
    overrideReason: "migration 20260928 expected to spike 5xx",
  });
  assert.match(text, /Auto-rollback is DISABLED by manual override: migration 20260928/);
  assert.match(text, /still live/);
  assert.doesNotMatch(text, /Automatic rollback is starting/);
});

test("rollback alerts name both slots and the post-rollback health", () => {
  const done = buildAlertPayload("rollback", { ...alertCtx, rollbackHealth: "healthy (HTTP 200)" }).text;
  assert.match(done, /Automatic rollback completed/);
  assert.match(done, /`green`.*`blue`/);
  assert.match(done, /healthy \(HTTP 200\)/);

  const failed = buildAlertPayload("rollback_failed", alertCtx).text;
  assert.match(failed, /Automatic rollback FAILED/);
  assert.match(failed, /Manual intervention required/);
});

test("unknown alert kinds are rejected", () => {
  assert.throws(() => buildAlertPayload("nope", alertCtx), /Unknown alert kind/);
});

test("runGateCommand writes the report and outputs the rollback decision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-gate-"));
  const env = {
    HEALTH_URL,
    HEALTH_GATE_WINDOW_SECONDS: "60",
    HEALTH_GATE_INTERVAL_SECONDS: "10",
    REPORT_PATH: path.join(dir, "report.json"),
    GITHUB_OUTPUT: path.join(dir, "output.txt"),
  };
  const deps = { fetch: async () => response(503, "down"), ...fakeClock() };

  const { report, action } = await runGateCommand(env, deps);
  assert.equal(report.passed, false);
  assert.equal(action, "rollback");
  assert.equal(JSON.parse(fs.readFileSync(env.REPORT_PATH, "utf8")).failure.signal, "health_check_failed");
  const outputs = fs.readFileSync(env.GITHUB_OUTPUT, "utf8");
  assert.match(outputs, /passed=false/);
  assert.match(outputs, /action=rollback/);
  assert.match(outputs, /signal=health_check_failed/);
});

test("runGateCommand honours AUTO_ROLLBACK_DISABLED by downgrading to alert_only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-gate-"));
  const env = {
    HEALTH_URL,
    HEALTH_GATE_WINDOW_SECONDS: "60",
    HEALTH_GATE_INTERVAL_SECONDS: "10",
    AUTO_ROLLBACK_DISABLED: "true",
    REPORT_PATH: path.join(dir, "report.json"),
    GITHUB_OUTPUT: path.join(dir, "output.txt"),
  };
  const { action } = await runGateCommand(env, {
    fetch: async () => response(503),
    ...fakeClock(),
  });
  assert.equal(action, "alert_only");
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, "utf8"), /action=alert_only/);
});

test("runAlertCommand posts to the webhook, and never throws when delivery fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "health-gate-"));
  const reportPath = path.join(dir, "report.json");
  fs.writeFileSync(reportPath, JSON.stringify(failedReport));
  const env = {
    REPORT_PATH: reportPath,
    ENVIRONMENT: "production",
    IMAGE_TAG: "v1.2.3",
    DEVOPS_ALERT_WEBHOOK_URL: "https://hooks.example.com/x",
  };

  let posted = null;
  const ok = await runAlertCommand("failure", env, {
    fetch: async (url, init) => {
      posted = { url, body: JSON.parse(init.body) };
      return response(200);
    },
  });
  assert.equal(ok.delivered, true);
  assert.equal(posted.url, "https://hooks.example.com/x");
  assert.match(posted.body.text, /health_check_failed/);

  const failed = await runAlertCommand("failure", env, {
    fetch: async () => {
      throw new Error("webhook down");
    },
  });
  assert.equal(failed.delivered, false);

  const noWebhook = await runAlertCommand("rollback", { ...env, DEVOPS_ALERT_WEBHOOK_URL: "" }, { fetch: async () => response(200) });
  assert.equal(noWebhook.delivered, false);
});
