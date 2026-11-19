// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyAllowlist,
  buildSnapshot,
  diffSnapshots,
  looksSecret,
  renderReport,
  runCompare,
  updateHistory,
} from "./config-parity-drift.mjs";

const fx = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/config-parity/${name}.json`, import.meta.url), "utf8"));
const allowlist = JSON.parse(fs.readFileSync(new URL("../devops/config-parity-allowlist.json", import.meta.url), "utf8"));
const staging = fx("staging");

test("allowlisted differences produce no noise", () => {
  const { expected, unexpected } = applyAllowlist(diffSnapshots(staging, fx("production-clean")), allowlist);
  assert.deepEqual(unexpected, []);
  assert.ok(expected.length >= 5);
  assert.ok(expected.every((d) => d.reason));
});

test("unexpected differences are reported with their kind", () => {
  const { unexpected } = applyAllowlist(diffSnapshots(staging, fx("production-drifted")), allowlist);
  const byKey = Object.fromEntries(unexpected.map((d) => [d.key, d]));
  assert.deepEqual(Object.keys(byKey).sort(), [
    "env.INVITE_CODE_REQUIRED",
    "env.LOG_LEVEL",
    "flag.new-flag",
    "flag.risk-based-pricing",
    "runtime.memory",
  ]);
  assert.equal(byKey["env.INVITE_CODE_REQUIRED"].kind, "missing_in_production");
  assert.equal(byKey["flag.new-flag"].kind, "missing_in_staging");
  assert.equal(byKey["env.LOG_LEVEL"].kind, "differs");
});

test("an allowlisted key with an `expect` is still reported when it moves off the expected values", () => {
  const { unexpected } = applyAllowlist(diffSnapshots(staging, fx("production-drifted")), allowlist);
  const mem = unexpected.find((d) => d.key === "runtime.memory");
  assert.equal(mem.production, "8192");
  assert.match(mem.note, /expected values/);
});

test("wildcard allowlist entries match by prefix", () => {
  const diffs = [{ key: "flag.beta-x", staging: "1", production: "0", kind: "differs" }];
  assert.equal(applyAllowlist(diffs, { allow: [{ key: "flag.beta-*", reason: "beta flags" }] }).unexpected.length, 0);
  assert.equal(applyAllowlist(diffs, { allow: [{ key: "flag.other-*", reason: "x" }] }).unexpected.length, 1);
});

test("history records first-seen, alerts only on new drift, and records resolution", () => {
  const { unexpected } = applyAllowlist(diffSnapshots(staging, fx("production-drifted")), allowlist);
  const r1 = updateHistory({ drift: {} }, unexpected, "2026-10-02T00:00:00.000Z");
  assert.equal(r1.newDrift.length, 5);
  assert.equal(r1.history.drift["env.LOG_LEVEL"].firstSeen, "2026-10-02T00:00:00.000Z");

  const r2 = updateHistory(r1.history, unexpected, "2026-10-03T00:00:00.000Z");
  assert.equal(r2.newDrift.length, 0, "known drift does not re-alert");
  assert.equal(r2.history.drift["env.LOG_LEVEL"].firstSeen, "2026-10-02T00:00:00.000Z");
  assert.equal(r2.history.drift["env.LOG_LEVEL"].lastSeen, "2026-10-03T00:00:00.000Z");

  const fewer = unexpected.filter((d) => d.key !== "env.LOG_LEVEL");
  const r3 = updateHistory(r2.history, fewer, "2026-10-04T00:00:00.000Z");
  assert.deepEqual(r3.resolved, ["env.LOG_LEVEL"]);
  assert.equal(r3.history.drift["env.LOG_LEVEL"].status, "resolved");

  const r4 = updateHistory(r3.history, unexpected, "2026-10-05T00:00:00.000Z");
  assert.deepEqual(r4.newDrift.map((d) => d.key), ["env.LOG_LEVEL"], "recurrence of resolved drift alerts again");
});

test("snapshots never contain secrets", () => {
  assert.equal(looksSecret("env.SENDGRID_API_KEY", "x"), true);
  assert.equal(looksSecret("env.DATABASE_URL", "postgres://u:pw@host/db"), true);
  assert.equal(looksSecret("env.LOG_LEVEL", "info"), false);
  const snap = buildSnapshot({
    environment: "staging",
    service: {
      ServiceArn: "arn:x",
      InstanceConfiguration: { Cpu: "1024", Memory: "2048" },
      SourceConfiguration: {
        ImageRepository: {
          ImageIdentifier: "public.ecr.aws/remitmortgage/backend:v1.2.3",
          ImageConfiguration: {
            Port: "8080",
            RuntimeEnvironmentVariables: {
              LOG_LEVEL: "info",
              JWT_SECRET: "hunter2",
              DATABASE_URL: "postgres://user:pw@host/db",
              REDIS_URL: "redis://cache:6379",
            },
          },
        },
      },
    },
    flags: { "new-flag": "on" },
  });
  assert.equal(snap.config["image.tag"], "v1.2.3");
  assert.equal(snap.config["image.repository"], "public.ecr.aws/remitmortgage/backend");
  assert.equal(snap.config["env.LOG_LEVEL"], "info");
  assert.equal(snap.config["flag.new-flag"], "on");
  assert.equal("env.JWT_SECRET" in snap.config, false);
  assert.equal("env.DATABASE_URL" in snap.config, false);
  assert.ok(!JSON.stringify(snap).includes("hunter2"));
});

test("report lists new drift with first-seen and notes suppressed entries", () => {
  const { expected, unexpected } = applyAllowlist(diffSnapshots(staging, fx("production-drifted")), allowlist);
  const { history, newDrift, resolved } = updateHistory({ drift: {} }, unexpected, "2026-10-02T00:00:00.000Z");
  const md = renderReport({ unexpected, expected, newDrift, resolved, history });
  assert.match(md, /5 unexpected differences \(5 new\)/);
  assert.match(md, /`env.LOG_LEVEL` \| `debug` \| `info` \| 2026-10-02/);
  assert.match(md, /allowlisted differences? suppressed/);
  const clean = renderReport({ unexpected: [], expected, newDrift: [], resolved: [], history: { drift: {} } });
  assert.match(clean, /No unexpected differences/);
});

test("runCompare end-to-end persists history and flags drift via outputs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-"));
  const out = path.join(dir, "out");
  const historyPath = path.join(dir, "history.json");
  const args = {
    staging: new URL("./fixtures/config-parity/staging.json", import.meta.url).pathname,
    production: new URL("./fixtures/config-parity/production-drifted.json", import.meta.url).pathname,
    allowlist: new URL("../devops/config-parity-allowlist.json", import.meta.url).pathname,
    history: historyPath,
  };
  const first = runCompare(args, "2026-10-02T00:00:00.000Z", { GITHUB_OUTPUT: out });
  assert.equal(first.unexpected.length, 5);
  assert.match(fs.readFileSync(out, "utf8"), /drift=true\nnew_drift=true/);
  const second = runCompare(args, "2026-10-03T00:00:00.000Z", { GITHUB_OUTPUT: out });
  assert.equal(second.newDrift.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(historyPath, "utf8")).drift["flag.new-flag"].firstSeen, "2026-10-02T00:00:00.000Z");

  const clean = runCompare({ ...args, production: new URL("./fixtures/config-parity/production-clean.json", import.meta.url).pathname }, "2026-10-04T00:00:00.000Z", {});
  assert.equal(clean.unexpected.length, 0);
  assert.equal(clean.resolved.length, 5);
});
