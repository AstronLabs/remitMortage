// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAlertPayload,
  configFromEnv,
  createInvalidation,
  discoverDistributionId,
  pollInvalidationStatus,
  runInvalidationCommand,
  sendAlert,
} from "./invalidate-cdn-cache.mjs";

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

function response(status, body = "") {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

test("configFromEnv parses env vars and defaults correctly", () => {
  const defaults = configFromEnv({});
  assert.equal(defaults.distributionId, null);
  assert.deepEqual(defaults.paths, ["/_next/static/*", "/public/*"]);
  assert.equal(defaults.timeoutMs, 300_000);
  assert.equal(defaults.environment, "dev");

  const custom = configFromEnv({
    CLOUDFRONT_DISTRIBUTION_ID: "EDFD12345",
    INVALIDATION_PATHS: "/_next/static/* /public/* /index.html",
    INVALIDATION_TIMEOUT_SECONDS: "60",
    ENVIRONMENT: "production",
    RUN_URL: "https://github.com/org/repo/actions/runs/1",
    DEVOPS_ALERT_WEBHOOK_URL: "https://hooks.example.com/alert",
  });
  assert.equal(custom.distributionId, "EDFD12345");
  assert.deepEqual(custom.paths, ["/_next/static/*", "/public/*", "/index.html"]);
  assert.equal(custom.timeoutMs, 60_000);
  assert.equal(custom.environment, "production");
  assert.equal(custom.webhookUrl, "https://hooks.example.com/alert");
});

test("discoverDistributionId returns configured ID or queries SSM / list-distributions", async () => {
  const directId = await discoverDistributionId({ distributionId: "EXX123" });
  assert.equal(directId, "EXX123");

  // SSM fallback
  const ssmId = await discoverDistributionId(
    { environment: "production" },
    {
      exec: async (cmd, args) => {
        if (args.includes("ssm")) return { stdout: "E_SSM_999\n", stderr: "" };
        throw new Error("unexpected call");
      },
    }
  );
  assert.equal(ssmId, "E_SSM_999");

  // List distributions fallback
  const listId = await discoverDistributionId(
    { environment: "production" },
    {
      exec: async (cmd, args) => {
        if (args.includes("ssm")) throw new Error("ssm parameter not found");
        if (args.includes("list-distributions")) {
          return {
            stdout: JSON.stringify({
              DistributionList: {
                Items: [
                  { Id: "E_OTHER", Comment: "Other project" },
                  { Id: "E_REMIT_PROD", Comment: "RemitMortgage frontend production" },
                ],
              },
            }),
            stderr: "",
          };
        }
        throw new Error("unexpected command");
      },
    }
  );
  assert.equal(listId, "E_REMIT_PROD");
});

test("createInvalidation issues AWS CLI command and parses output", async () => {
  let executedArgs = null;
  const result = await createInvalidation(
    "EDFD12345",
    ["/_next/static/*", "/public/*"],
    {
      exec: async (cmd, args) => {
        executedArgs = args;
        return {
          stdout: JSON.stringify({
            Invalidation: {
              Id: "INV_999",
              Status: "InProgress",
              InvalidationBatch: { Paths: { Items: ["/_next/static/*", "/public/*"] } },
            },
          }),
          stderr: "",
        };
      },
    }
  );

  assert.equal(result.invalidationId, "INV_999");
  assert.equal(result.status, "InProgress");
  assert.ok(executedArgs.includes("EDFD12345"));
  assert.ok(executedArgs.includes("/_next/static/*"));
});

test("pollInvalidationStatus polls until status is Completed", async () => {
  const clock = fakeClock();
  let calls = 0;
  const result = await pollInvalidationStatus(
    "EDFD12345",
    "INV_999",
    60_000,
    5_000,
    {
      ...clock,
      exec: async () => {
        calls += 1;
        return {
          stdout: JSON.stringify({
            Invalidation: {
              Id: "INV_999",
              Status: calls >= 3 ? "Completed" : "InProgress",
            },
          }),
          stderr: "",
        };
      },
    }
  );

  assert.equal(result.completed, true);
  assert.equal(result.status, "Completed");
  assert.equal(calls, 3);
});

test("pollInvalidationStatus returns TimedOut when status stays InProgress past timeout", async () => {
  const clock = fakeClock();
  const result = await pollInvalidationStatus(
    "EDFD12345",
    "INV_999",
    10_000,
    5_000,
    {
      ...clock,
      exec: async () => ({
        stdout: JSON.stringify({ Invalidation: { Id: "INV_999", Status: "InProgress" } }),
        stderr: "",
      }),
    }
  );

  assert.equal(result.completed, false);
  assert.equal(result.status, "TimedOut");
});

test("buildAlertPayload creates failure and success markdown alert text", () => {
  const failurePayload = buildAlertPayload("failure", {
    environment: "production",
    distributionId: "EDFD12345",
    invalidationId: "INV_999",
    paths: ["/_next/static/*"],
    error: "Timed out waiting for invalidation",
    runUrl: "https://github.com/org/repo/actions/runs/100",
  }).text;

  assert.match(failurePayload, /🚨 \*CDN Cache Invalidation FAILED\*/);
  assert.match(failurePayload, /EDFD12345/);
  assert.match(failurePayload, /INV_999/);
  assert.match(failurePayload, /Timed out waiting for invalidation/);
  assert.match(failurePayload, /Stale static assets may remain cached/);
  assert.match(failurePayload, /actions\/runs\/100/);

  const successPayload = buildAlertPayload("success", {
    environment: "production",
    distributionId: "EDFD12345",
    invalidationId: "INV_999",
    paths: ["/_next/static/*"],
    durationMs: 15_000,
  }).text;

  assert.match(successPayload, /✅ \*CDN Cache Invalidation Completed\*/);
  assert.match(successPayload, /Completed in 15s/);
});

test("sendAlert handles POST requests and missing webhooks", async () => {
  const alertNoWebhook = await sendAlert("success", { environment: "dev" });
  assert.equal(alertNoWebhook.delivered, false);

  let postedBody = null;
  const alertWithWebhook = await sendAlert(
    "failure",
    {
      environment: "production",
      distributionId: "EDFD12345",
      webhookUrl: "https://hooks.example.com/alert",
      error: "Access denied",
    },
    {
      fetch: async (url, opts) => {
        postedBody = JSON.parse(opts.body);
        return response(200);
      },
    }
  );

  assert.equal(alertWithWebhook.delivered, true);
  assert.match(postedBody.text, /CDN Cache Invalidation FAILED/);
});

test("runInvalidationCommand completes end-to-end and outputs to GITHUB_OUTPUT", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-invalidation-"));
  const outputFile = path.join(dir, "output.txt");

  const env = {
    CLOUDFRONT_DISTRIBUTION_ID: "EDFD12345",
    INVALIDATION_PATHS: "/_next/static/* /public/*",
    GITHUB_OUTPUT: outputFile,
  };

  const clock = fakeClock();
  const deps = {
    ...clock,
    exec: async (cmd, args) => {
      if (args.includes("create-invalidation")) {
        return {
          stdout: JSON.stringify({ Invalidation: { Id: "INV_100", Status: "InProgress" } }),
          stderr: "",
        };
      }
      if (args.includes("get-invalidation")) {
        return {
          stdout: JSON.stringify({ Invalidation: { Id: "INV_100", Status: "Completed" } }),
          stderr: "",
        };
      }
      throw new Error("unexpected command");
    },
  };

  const result = await runInvalidationCommand(env, deps);
  assert.equal(result.success, true);
  assert.equal(result.distributionId, "EDFD12345");
  assert.equal(result.invalidationId, "INV_100");

  const outputs = fs.readFileSync(outputFile, "utf8");
  assert.match(outputs, /status=Completed/);
  assert.match(outputs, /invalidation_id=INV_100/);
});

test("runInvalidationCommand handles invalidation failure and outputs error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cdn-invalidation-"));
  const outputFile = path.join(dir, "output.txt");

  const env = {
    CLOUDFRONT_DISTRIBUTION_ID: "EDFD12345",
    GITHUB_OUTPUT: outputFile,
  };

  const deps = {
    exec: async (cmd, args) => {
      if (args.includes("create-invalidation")) {
        throw new Error("AccessDenied: User is not authorized to perform: cloudfront:CreateInvalidation");
      }
      throw new Error("unexpected command");
    },
  };

  const result = await runInvalidationCommand(env, deps);
  assert.equal(result.success, false);
  assert.match(result.error, /AccessDenied/);

  const outputs = fs.readFileSync(outputFile, "utf8");
  assert.match(outputs, /status=Failed/);
});
