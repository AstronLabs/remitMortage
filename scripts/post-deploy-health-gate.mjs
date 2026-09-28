// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Post-deploy health gate (automatic rollback trigger).
 *
 * Runs right after traffic is switched to a new blue/green slot. Polls the
 * service's health endpoint and (when reachable) its Prometheus HTTP error
 * counters for a defined window, and reports whether the deploy is healthy.
 * `.github/workflows/blue-green-deploy.yml` rolls back to the previous slot
 * when this reports a failure — see `docs/AUTOMATIC_ROLLBACK.md`.
 *
 * Signals (either failing the window fails the deploy):
 *   - health_check_failed: `/api/health` not 2xx (or unreachable/timed out)
 *     for N consecutive polls. A single blip never fails the gate.
 *   - error_rate_exceeded: share of 5xx responses, accumulated from
 *     `remitmortgage_http_requests_total` deltas across the window, exceeds
 *     the threshold — but only once enough requests were observed for the
 *     ratio to mean anything.
 *
 * Manual override: AUTO_ROLLBACK_DISABLED=true keeps the gate running and
 * alerting but downgrades the action from "rollback" to "alert_only", for an
 * intentional deploy expected to trip a signal briefly (e.g. a migration).
 *
 * Usage:
 *   node scripts/post-deploy-health-gate.mjs gate            # run the window
 *   node scripts/post-deploy-health-gate.mjs alert <kind>    # failure | rollback | rollback_failed
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const METRIC_NAME = "remitmortgage_http_requests_total";

// ---------------------------------------------------------------------------
// Metrics parsing
// ---------------------------------------------------------------------------

/** Sums total and 5xx request counts out of Prometheus text exposition. */
export function parseHttpRequestCounts(metricsText) {
  const pattern = new RegExp(`^${METRIC_NAME}(?:\\{([^}]*)\\})?\\s+([0-9.eE+-]+)\\s*$`);
  let total = 0;
  let errors = 0;

  for (const line of String(metricsText).split("\n")) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;

    const status = /status_code="(\d+)"/.exec(match[1] ?? "")?.[1] ?? "";
    total += value;
    if (status.startsWith("5")) errors += value;
  }
  return { total, errors };
}

/**
 * Accumulates request/error deltas between successive counter samples. A
 * counter that went backwards means the process restarted, so the new value
 * is itself the delta since restart.
 */
export function accumulateDelta(acc, previous, current) {
  const delta = (cur, prev) => (cur >= prev ? cur - prev : cur);
  return {
    requests: acc.requests + delta(current.total, previous.total),
    errors: acc.errors + delta(current.errors, previous.errors),
  };
}

// ---------------------------------------------------------------------------
// Health window
// ---------------------------------------------------------------------------

const BODY_SNIPPET_LIMIT = 500;

async function probeHealth(url, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (res.ok) return { healthy: true, status: res.status };
    let body = "";
    try {
      body = (await res.text()).slice(0, BODY_SNIPPET_LIMIT);
    } catch {
      // Body is diagnostic only.
    }
    return { healthy: false, status: res.status, body };
  } catch (err) {
    return {
      healthy: false,
      status: null,
      error: err?.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function scrapeMetrics(url, token, timeoutMs, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return null;
    return parseHttpRequestCounts(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Polls health/error-rate signals for `windowMs`, returning as soon as a
 * signal fails (a bad deploy should be rolled back promptly, not after the
 * whole window) or the window elapses cleanly.
 */
export async function runHealthGate(config, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const start = now();
  const health = { total: 0, failed: 0, consecutiveFailures: 0, last: null };
  const errorRate = {
    available: false,
    requests: 0,
    errors: 0,
    rate: 0,
    threshold: config.maxErrorRate,
    minRequests: config.minRequests,
  };

  let previousMetrics = null;
  let acc = { requests: 0, errors: 0 };
  let failure = null;

  const sampleMetrics = async () => {
    if (!config.metricsUrl) return;
    const sample = await scrapeMetrics(
      config.metricsUrl,
      config.metricsToken,
      config.requestTimeoutMs,
      fetchImpl
    );
    if (!sample) return;
    errorRate.available = true;
    if (previousMetrics) acc = accumulateDelta(acc, previousMetrics, sample);
    previousMetrics = sample;
    errorRate.requests = acc.requests;
    errorRate.errors = acc.errors;
    errorRate.rate = acc.requests > 0 ? acc.errors / acc.requests : 0;
  };

  // Baseline so only traffic since the switch is judged.
  await sampleMetrics();

  while (!failure) {
    const probe = await probeHealth(config.healthUrl, config.requestTimeoutMs, fetchImpl);
    health.total += 1;
    health.last = probe;
    if (probe.healthy) {
      health.consecutiveFailures = 0;
    } else {
      health.failed += 1;
      health.consecutiveFailures += 1;
    }

    await sampleMetrics();

    if (health.consecutiveFailures >= config.maxConsecutiveHealthFailures) {
      failure = {
        signal: "health_check_failed",
        message:
          `Health endpoint failed ${health.consecutiveFailures} consecutive checks ` +
          `(last: ${probe.status ?? probe.error}).`,
      };
    } else if (
      errorRate.available &&
      errorRate.requests >= config.minRequests &&
      errorRate.rate > config.maxErrorRate
    ) {
      failure = {
        signal: "error_rate_exceeded",
        message:
          `5xx rate ${(errorRate.rate * 100).toFixed(1)}% over ${errorRate.requests} requests ` +
          `exceeds the ${(config.maxErrorRate * 100).toFixed(1)}% threshold.`,
      };
    }

    if (failure || now() - start >= config.windowMs) break;
    await sleep(config.intervalMs);
  }

  return {
    passed: failure === null,
    failure,
    durationMs: now() - start,
    windowMs: config.windowMs,
    healthChecks: {
      total: health.total,
      failed: health.failed,
      consecutiveFailures: health.consecutiveFailures,
      lastStatus: health.last?.status ?? null,
      lastError: health.last?.error ?? null,
      lastBody: health.last?.body ?? null,
    },
    errorRate,
  };
}

// ---------------------------------------------------------------------------
// Decision + alerting
// ---------------------------------------------------------------------------

export function isTruthy(value) {
  return ["true", "1", "yes"].includes(String(value ?? "").trim().toLowerCase());
}

/** rollback | alert_only (override on) | none (healthy). */
export function decideAction({ passed, autoRollbackDisabled }) {
  if (passed) return "none";
  return autoRollbackDisabled ? "alert_only" : "rollback";
}

/** Chat payload for a gate failure or a rollback outcome, with root-cause context. */
export function buildAlertPayload(kind, ctx) {
  const lines = [];
  const target = `${ctx.environment ?? "unknown"} (image \`${ctx.imageTag ?? "unknown"}\`)`;
  const report = ctx.report ?? null;

  if (kind === "failure") {
    lines.push(`🚨 *Post-deploy health check FAILED* — ${target}`);
    if (report?.failure) {
      lines.push(`Signal: \`${report.failure.signal}\``);
      lines.push(report.failure.message);
    }
    if (report) {
      const h = report.healthChecks;
      lines.push(
        `Health checks: ${h.failed}/${h.total} failed, last status ${h.lastStatus ?? "n/a"}` +
          (h.lastError ? ` (${h.lastError})` : "")
      );
      if (h.lastBody) lines.push(`Last health response: ${h.lastBody}`);
      lines.push(
        report.errorRate.available
          ? `5xx rate: ${(report.errorRate.rate * 100).toFixed(1)}% (${report.errorRate.errors}/${report.errorRate.requests} requests)`
          : "5xx rate: unavailable (metrics endpoint unreachable — health signal only)"
      );
      lines.push(`Failed ${Math.round(report.durationMs / 1000)}s into the ${Math.round(report.windowMs / 1000)}s window.`);
    }
    lines.push(
      ctx.autoRollbackDisabled
        ? `⚠️ Auto-rollback is DISABLED by manual override${ctx.overrideReason ? `: ${ctx.overrideReason}` : ""}. The bad deploy is still live.`
        : "Automatic rollback is starting."
    );
  } else if (kind === "rollback") {
    lines.push(`↩️ *Automatic rollback completed* — ${target}`);
    lines.push(`Traffic returned from slot \`${ctx.newSlot}\` to previous known-good slot \`${ctx.previousSlot}\`.`);
    lines.push(`Previous slot health after rollback: ${ctx.rollbackHealth ?? "unknown"}.`);
  } else if (kind === "rollback_failed") {
    lines.push(`🔥 *Automatic rollback FAILED* — ${target}`);
    lines.push(`Could not return traffic to slot \`${ctx.previousSlot}\`. Manual intervention required NOW.`);
    if (ctx.rollbackHealth) lines.push(`Previous slot health: ${ctx.rollbackHealth}.`);
  } else {
    throw new Error(`Unknown alert kind: ${kind}`);
  }

  if (ctx.runUrl) lines.push(`Run: ${ctx.runUrl}`);
  lines.push("Runbook: `docs/AUTOMATIC_ROLLBACK.md`");
  return { text: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function numberFromEnv(env, name, fallback, { min = 0 } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${name} must be a number >= ${min} (got "${raw}")`);
  }
  return value;
}

export function configFromEnv(env) {
  if (!env.HEALTH_URL) throw new Error("HEALTH_URL is required");
  return {
    healthUrl: env.HEALTH_URL,
    metricsUrl: env.METRICS_URL || null,
    metricsToken: env.METRICS_TOKEN || null,
    windowMs: numberFromEnv(env, "HEALTH_GATE_WINDOW_SECONDS", 300) * 1000,
    intervalMs: numberFromEnv(env, "HEALTH_GATE_INTERVAL_SECONDS", 10, { min: 0.001 }) * 1000,
    requestTimeoutMs: numberFromEnv(env, "HEALTH_GATE_REQUEST_TIMEOUT_SECONDS", 5, { min: 0.001 }) * 1000,
    maxConsecutiveHealthFailures: numberFromEnv(env, "HEALTH_GATE_MAX_CONSECUTIVE_FAILURES", 3, { min: 1 }),
    maxErrorRate: numberFromEnv(env, "HEALTH_GATE_MAX_ERROR_RATE", 0.05),
    minRequests: numberFromEnv(env, "HEALTH_GATE_MIN_REQUESTS", 20),
  };
}

function appendGithubOutput(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
    .join("\n");
  fs.appendFileSync(env.GITHUB_OUTPUT, `${body}\n`);
}

/** Runs the window, writes the report + step outputs, returns the decision. */
export async function runGateCommand(env, deps = {}) {
  const config = configFromEnv(env);
  const report = await runHealthGate(config, deps);
  const action = decideAction({
    passed: report.passed,
    autoRollbackDisabled: isTruthy(env.AUTO_ROLLBACK_DISABLED),
  });

  fs.writeFileSync(env.REPORT_PATH || "health-gate-report.json", JSON.stringify(report, null, 2));
  appendGithubOutput(env, {
    passed: report.passed,
    action,
    signal: report.failure?.signal ?? "",
  });
  return { report, action };
}

/** Best-effort: an alerting problem must never mask the deploy outcome. */
export async function runAlertCommand(kind, env, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(env.REPORT_PATH || "health-gate-report.json", "utf8"));
  } catch {
    // No report (e.g. rollback alerts) is fine.
  }

  const payload = buildAlertPayload(kind, {
    environment: env.ENVIRONMENT,
    imageTag: env.IMAGE_TAG,
    newSlot: env.NEW_SLOT,
    previousSlot: env.PREVIOUS_SLOT,
    rollbackHealth: env.ROLLBACK_HEALTH,
    runUrl: env.RUN_URL,
    autoRollbackDisabled: isTruthy(env.AUTO_ROLLBACK_DISABLED),
    overrideReason: env.OVERRIDE_REASON,
    report,
  });

  console.log(payload.text);
  if (!env.DEVOPS_ALERT_WEBHOOK_URL) {
    console.log("DEVOPS_ALERT_WEBHOOK_URL not set; skipping chat notification.");
    return { payload, delivered: false };
  }
  try {
    const res = await fetchImpl(env.DEVOPS_ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { payload, delivered: res.ok };
  } catch (err) {
    console.warn(`Alert webhook POST failed (non-blocking): ${err?.message ?? err}`);
    return { payload, delivered: false };
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, arg] = argv;
  if (command === "gate") {
    const { report, action } = await runGateCommand(env);
    console.log(
      report.passed
        ? `✓ Post-deploy health gate passed (${report.healthChecks.total} checks over ${Math.round(report.durationMs / 1000)}s).`
        : `✗ Post-deploy health gate FAILED: ${report.failure.message} → action: ${action}`
    );
    return 0;
  }
  if (command === "alert" && arg) {
    await runAlertCommand(arg, env);
    return 0;
  }
  console.error("Usage: post-deploy-health-gate.mjs gate | alert <failure|rollback|rollback_failed>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(2);
    }
  );
}
