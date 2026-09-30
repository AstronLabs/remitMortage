// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * CDN Cache Invalidation Script
 *
 * Triggers and monitors CloudFront CDN cache invalidation after deployments
 * to prevent stale static assets (JS/CSS/images) from causing version mismatches.
 *
 * Usage:
 *   node scripts/invalidate-cdn-cache.mjs [command]
 * Commands:
 *   invalidate (default) - Create invalidation and wait for completion
 *   alert failure|success - Send webhook alert manually
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function configFromEnv(env = process.env) {
  const rawPaths = env.INVALIDATION_PATHS || env.PATHS;
  let paths;
  if (rawPaths) {
    paths = rawPaths.split(/[\s,]+/).filter(Boolean);
  } else {
    paths = ["/_next/static/*", "/public/*"];
  }

  const timeoutSec = Number(env.INVALIDATION_TIMEOUT_SECONDS ?? 300);
  const pollIntervalMs = Number(env.INVALIDATION_POLL_INTERVAL_MS ?? 5000);

  return {
    distributionId: env.CLOUDFRONT_DISTRIBUTION_ID || env.DISTRIBUTION_ID || null,
    paths,
    timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 300_000,
    pollIntervalMs: Number.isFinite(pollIntervalMs) && pollIntervalMs > 0 ? pollIntervalMs : 5000,
    environment: env.ENVIRONMENT || "dev",
    runUrl: env.RUN_URL || "",
    webhookUrl: env.DEVOPS_ALERT_WEBHOOK_URL || env.SLACK_WEBHOOK_URL || null,
  };
}

export function defaultExec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export async function discoverDistributionId(config, deps = {}) {
  if (config.distributionId) return config.distributionId;
  const execImpl = deps.exec ?? defaultExec;

  try {
    const ssmParamName = `/remitmortgage/${config.environment}/cloudfront-distribution-id`;
    const { stdout } = await execImpl("aws", [
      "ssm",
      "get-parameter",
      "--name",
      ssmParamName,
      "--query",
      "Parameter.Value",
      "--output",
      "text",
    ]);
    const id = stdout.trim();
    if (id && id !== "None") return id;
  } catch {
    // SSM lookup failed or parameter does not exist
  }

  try {
    const { stdout } = await execImpl("aws", [
      "cloudfront",
      "list-distributions",
      "--output",
      "json",
    ]);
    const data = JSON.parse(stdout);
    const items = data?.DistributionList?.Items || [];
    const targetEnv = (config.environment || "dev").toLowerCase();

    for (const dist of items) {
      const comment = (dist.Comment || "").toLowerCase();
      if (comment.includes("remitmortgage") || comment.includes("remit-mortgage")) {
        if (comment.includes(targetEnv) || items.length === 1) {
          return dist.Id;
        }
      }
    }
    if (items.length > 0) return items[0].Id;
  } catch {
    // Discovery failed
  }

  return null;
}

export async function createInvalidation(distributionId, paths, deps = {}) {
  const execImpl = deps.exec ?? defaultExec;
  const args = [
    "cloudfront",
    "create-invalidation",
    "--distribution-id",
    distributionId,
    "--paths",
    ...paths,
    "--output",
    "json",
  ];

  const { stdout } = await execImpl("aws", args);
  const data = JSON.parse(stdout);
  const invalidation = data.Invalidation || data;
  return {
    invalidationId: invalidation.Id,
    status: invalidation.Status || "InProgress",
    paths: invalidation.InvalidationBatch?.Paths?.Items || paths,
    createTime: invalidation.CreateTime,
  };
}

export async function pollInvalidationStatus(distributionId, invalidationId, timeoutMs, pollIntervalMs, deps = {}) {
  const execImpl = deps.exec ?? defaultExec;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const startTime = now();

  while (now() - startTime < timeoutMs) {
    try {
      const { stdout } = await execImpl("aws", [
        "cloudfront",
        "get-invalidation",
        "--distribution-id",
        distributionId,
        "--id",
        invalidationId,
        "--output",
        "json",
      ]);
      const data = JSON.parse(stdout);
      const status = data?.Invalidation?.Status;

      if (status === "Completed") {
        return { completed: true, status: "Completed", durationMs: now() - startTime };
      }
    } catch (err) {
      console.warn(`Warning: failed to poll invalidation status: ${err?.message || err}`);
    }

    await sleep(pollIntervalMs);
  }

  return { completed: false, status: "TimedOut", durationMs: now() - startTime };
}

export function buildAlertPayload(kind, ctx) {
  const lines = [];
  const target = `${ctx.environment || "unknown"} (Distribution: \`${ctx.distributionId || "unknown"}\`)`;

  if (kind === "failure") {
    lines.push(`🚨 *CDN Cache Invalidation FAILED* — ${target}`);
    if (ctx.invalidationId) lines.push(`Invalidation ID: \`${ctx.invalidationId}\``);
    if (ctx.paths && ctx.paths.length) lines.push(`Paths: \`${ctx.paths.join("`, `")}\``);
    if (ctx.error) lines.push(`Error: ${ctx.error}`);
    lines.push("⚠️ Stale static assets may remain cached at CloudFront edge locations, causing frontend version mismatches.");
  } else if (kind === "success") {
    lines.push(`✅ *CDN Cache Invalidation Completed* — ${target}`);
    if (ctx.invalidationId) lines.push(`Invalidation ID: \`${ctx.invalidationId}\``);
    if (ctx.paths && ctx.paths.length) lines.push(`Paths: \`${ctx.paths.join("`, `")}\``);
    if (ctx.durationMs) lines.push(`Completed in ${Math.round(ctx.durationMs / 1000)}s.`);
  } else {
    throw new Error(`Unknown alert kind: ${kind}`);
  }

  if (ctx.runUrl) lines.push(`Run: ${ctx.runUrl}`);
  lines.push("Documentation: `docs/GEO_DNS_CDN_TESTING.md`");
  return { text: lines.join("\n") };
}

export async function sendAlert(kind, ctx, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const payload = buildAlertPayload(kind, ctx);

  console.log(payload.text);

  if (!ctx.webhookUrl) {
    console.log("DEVOPS_ALERT_WEBHOOK_URL not set; skipping chat notification.");
    return { payload, delivered: false };
  }

  try {
    const res = await fetchImpl(ctx.webhookUrl, {
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

function appendGithubOutput(env, values) {
  if (!env.GITHUB_OUTPUT) return;
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`)
    .join("\n");
  fs.appendFileSync(env.GITHUB_OUTPUT, `${body}\n`);
}

export async function runInvalidationCommand(env = process.env, deps = {}) {
  const config = configFromEnv(env);

  console.log("=== Starting CDN Cache Invalidation ===");
  const distributionId = await discoverDistributionId(config, deps);

  if (!distributionId) {
    const errorMsg = "No CloudFront distribution ID found or specified.";
    console.error(`::error::${errorMsg}`);
    await sendAlert("failure", { ...config, error: errorMsg }, deps);
    appendGithubOutput(env, { status: "Failed", error: errorMsg });
    return { success: false, error: errorMsg };
  }

  console.log(`CloudFront Distribution ID: ${distributionId}`);
  console.log(`Paths to invalidate: ${config.paths.join(", ")}`);

  let invalidation;
  try {
    invalidation = await createInvalidation(distributionId, config.paths, deps);
    console.log(`✓ Invalidation request accepted. Invalidation ID: ${invalidation.invalidationId}`);
  } catch (err) {
    const errorMsg = `Failed to create CloudFront invalidation: ${err?.stderr || err?.message || err}`;
    console.error(`::error::${errorMsg}`);
    await sendAlert("failure", { ...config, distributionId, error: errorMsg }, deps);
    appendGithubOutput(env, { status: "Failed", distribution_id: distributionId, error: errorMsg });
    return { success: false, error: errorMsg };
  }

  console.log(`Polling status of invalidation ${invalidation.invalidationId} (timeout: ${Math.round(config.timeoutMs / 1000)}s)...`);
  const pollResult = await pollInvalidationStatus(
    distributionId,
    invalidation.invalidationId,
    config.timeoutMs,
    config.pollIntervalMs,
    deps
  );

  if (!pollResult.completed) {
    const errorMsg = `CloudFront invalidation ${invalidation.invalidationId} failed to complete within ${Math.round(config.timeoutMs / 1000)}s (status: ${pollResult.status})`;
    console.error(`::error::${errorMsg}`);
    await sendAlert(
      "failure",
      {
        ...config,
        distributionId,
        invalidationId: invalidation.invalidationId,
        paths: invalidation.paths,
        error: errorMsg,
      },
      deps
    );
    appendGithubOutput(env, {
      status: "Failed",
      distribution_id: distributionId,
      invalidation_id: invalidation.invalidationId,
      error: errorMsg,
    });
    return { success: false, error: errorMsg };
  }

  console.log(`✓ Invalidation ${invalidation.invalidationId} completed successfully in ${Math.round(pollResult.durationMs / 1000)}s.`);
  await sendAlert(
    "success",
    {
      ...config,
      distributionId,
      invalidationId: invalidation.invalidationId,
      paths: invalidation.paths,
      durationMs: pollResult.durationMs,
    },
    deps
  );

  appendGithubOutput(env, {
    status: "Completed",
    distribution_id: distributionId,
    invalidation_id: invalidation.invalidationId,
    paths: config.paths.join(","),
  });

  return { success: true, distributionId, invalidationId: invalidation.invalidationId };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const [command, arg] = argv;
  if (command === "alert" && arg) {
    const config = configFromEnv(env);
    await sendAlert(arg, config, deps);
    return 0;
  }

  const result = await runInvalidationCommand(env, deps);
  return result.success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message ?? err);
      process.exit(1);
    }
  );
}
