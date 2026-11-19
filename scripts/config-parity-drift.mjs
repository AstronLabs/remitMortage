// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Configuration parity drift detection between staging and production
 * (issue #931).
 *
 * `collect` snapshots the non-secret runtime configuration of one environment
 * (App Runner env vars, image tag, sizing, and feature-flag SSM parameters).
 * `compare` diffs the two snapshots, drops differences listed in
 * devops/config-parity-allowlist.json, and reports the rest. A history file
 * records when each unexpected difference first appeared and when it was
 * resolved, so only *new* drift alerts.
 *
 * Secrets are never collected: App Runner only returns secret *references*
 * separately, and anything that still looks secret (by key name or embedded
 * credentials) is dropped from the snapshot.
 *
 * Usage:
 *   node scripts/config-parity-drift.mjs collect --environment staging --out staging.json
 *   node scripts/config-parity-drift.mjs compare --staging staging.json --production production.json \
 *        [--allowlist devops/config-parity-allowlist.json] [--history history.json] [--report report.md]
 *   -> exit 0 = no unexpected drift, 2 = unexpected drift, 1 = error
 *      (writes `drift`, `new_drift` to $GITHUB_OUTPUT)
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SECRET_KEY = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL|API_?KEY|_KEY$|^KEY$|DSN)/i;
const CREDENTIALED_URL = /:\/\/[^/\s:@]+:[^/\s@]+@/;
const MAX_VALUE_LEN = 120;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/** True if the key/value pair must not be stored or printed. */
export function looksSecret(key, value) {
  return SECRET_KEY.test(key) || CREDENTIALED_URL.test(String(value ?? ""));
}

/** Builds a flat, secret-free { key: value } map from raw collected pieces. */
export function buildSnapshot({ environment, service, flags = {}, collectedAt = new Date().toISOString() }) {
  const config = {};
  const put = (key, value) => {
    if (value === undefined || value === null || value === "") return;
    if (looksSecret(key, value)) return;
    config[key] = String(value);
  };
  const image = service?.SourceConfiguration?.ImageRepository ?? {};
  const imageId = image.ImageIdentifier ?? "";
  const tag = imageId.includes(":") ? imageId.slice(imageId.lastIndexOf(":") + 1) : "";
  put("image.repository", imageId.includes(":") ? imageId.slice(0, imageId.lastIndexOf(":")) : imageId);
  put("image.tag", tag);
  put("service.arn", service?.ServiceArn);
  put("service.url", service?.ServiceUrl);
  put("runtime.cpu", service?.InstanceConfiguration?.Cpu);
  put("runtime.memory", service?.InstanceConfiguration?.Memory);
  put("runtime.port", image.ImageConfiguration?.Port);
  for (const [k, v] of Object.entries(image.ImageConfiguration?.RuntimeEnvironmentVariables ?? {})) put(`env.${k}`, v);
  for (const [k, v] of Object.entries(flags)) put(`flag.${k}`, v);
  return { environment, collectedAt, config };
}

function aws(args) {
  return JSON.parse(execFileSync("aws", [...args, "--output", "json"], { encoding: "utf8" }));
}

/** Reads the live environment through the AWS CLI. */
export function collectFromAws(environment, { region = process.env.AWS_REGION ?? "us-east-1" } = {}) {
  const name = `remit-mortgage-api-${environment}`;
  const arn = aws(["apprunner", "list-services", "--region", region, "--query", `ServiceSummaryList[?ServiceName=='${name}'].ServiceArn | [0]`]);
  if (!arn) throw new Error(`App Runner service ${name} not found`);
  const { Service } = aws(["apprunner", "describe-service", "--region", region, "--service-arn", arn]);
  const flags = {};
  try {
    const path = `/remitmortgage/${environment}/flags/`;
    const params = aws(["ssm", "get-parameters-by-path", "--region", region, "--path", path, "--recursive"]);
    for (const p of params.Parameters ?? []) {
      if (p.Type !== "SecureString") flags[p.Name.slice(path.length)] = p.Value;
    }
  } catch {
    // No flag parameters for this environment: nothing to compare.
  }
  return buildSnapshot({ environment, service: Service, flags });
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function matchesKey(pattern, key) {
  return pattern.endsWith("*") ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
}

/** Raw differences between two snapshots (before allowlisting). */
export function diffSnapshots(staging, production) {
  const keys = new Set([...Object.keys(staging.config), ...Object.keys(production.config)]);
  const out = [];
  for (const key of [...keys].sort()) {
    const s = staging.config[key];
    const p = production.config[key];
    if (s === p) continue;
    out.push({
      key,
      staging: s ?? null,
      production: p ?? null,
      kind: s === undefined ? "missing_in_staging" : p === undefined ? "missing_in_production" : "differs",
    });
  }
  return out;
}

/** Splits differences into expected (allowlisted) and unexpected. */
export function applyAllowlist(diffs, allowlist) {
  const entries = allowlist?.allow ?? [];
  const expected = [];
  const unexpected = [];
  for (const d of diffs) {
    const entry = entries.find((e) => matchesKey(e.key, d.key));
    const tolerated =
      entry && (!entry.expect || (entry.expect.staging === d.staging && entry.expect.production === d.production));
    if (tolerated) expected.push({ ...d, reason: entry.reason });
    else unexpected.push(entry?.expect ? { ...d, note: "allowlisted key changed from its expected values" } : d);
  }
  return { expected, unexpected };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Updates the drift history and reports which drift is new this run.
 * history shape: { drift: { [key]: { firstSeen, lastSeen, status, resolvedAt?, staging, production } } }
 */
export function updateHistory(history, unexpected, nowIso) {
  const next = { drift: { ...(history?.drift ?? {}) } };
  const newDrift = [];
  const present = new Set(unexpected.map((d) => d.key));
  for (const d of unexpected) {
    const prev = next.drift[d.key];
    if (!prev || prev.status === "resolved") {
      newDrift.push(d);
      next.drift[d.key] = { firstSeen: nowIso, lastSeen: nowIso, status: "open", staging: d.staging, production: d.production };
    } else {
      next.drift[d.key] = { ...prev, lastSeen: nowIso, staging: d.staging, production: d.production };
    }
  }
  const resolved = [];
  for (const [key, rec] of Object.entries(next.drift)) {
    if (rec.status === "open" && !present.has(key)) {
      next.drift[key] = { ...rec, status: "resolved", resolvedAt: nowIso };
      resolved.push(key);
    }
  }
  return { history: next, newDrift, resolved };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const show = (v) => (v === null ? "_(unset)_" : `\`${String(v).replace(/`/g, "'").slice(0, MAX_VALUE_LEN)}\``);

export function renderReport({ unexpected, expected, newDrift, resolved, history }) {
  const isNew = new Set(newDrift.map((d) => d.key));
  const lines = ["## Staging vs production configuration parity", ""];
  if (unexpected.length === 0) lines.push("✅ No unexpected differences.");
  else {
    lines.push(`⚠️ ${unexpected.length} unexpected difference${unexpected.length === 1 ? "" : "s"} (${newDrift.length} new).`, "");
    lines.push("| Key | Staging | Production | First seen | |", "| --- | --- | --- | --- | --- |");
    for (const d of unexpected) {
      const first = history?.drift?.[d.key]?.firstSeen ?? "now";
      lines.push(`| \`${d.key}\` | ${show(d.staging)} | ${show(d.production)} | ${first} | ${isNew.has(d.key) ? "🆕" : ""}${d.note ? ` ${d.note}` : ""} |`);
    }
  }
  if (resolved.length) lines.push("", `✔️ Resolved since last run: ${resolved.map((k) => `\`${k}\``).join(", ")}`);
  lines.push("", `<sub>${expected.length} allowlisted difference${expected.length === 1 ? "" : "s"} suppressed.</sub>`);
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[++i];
  return args;
}

const readJson = (p, fallback) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : fallback);

export function runCompare(args, nowIso = new Date().toISOString(), env = process.env) {
  const staging = readJson(args.staging);
  const production = readJson(args.production);
  if (!staging || !production) throw new Error("--staging and --production snapshots are required");
  const allowlist = readJson(args.allowlist ?? "devops/config-parity-allowlist.json", { allow: [] });
  const { expected, unexpected } = applyAllowlist(diffSnapshots(staging, production), allowlist);
  const { history, newDrift, resolved } = updateHistory(readJson(args.history, { drift: {} }), unexpected, nowIso);
  if (args.history) fs.writeFileSync(args.history, JSON.stringify(history, null, 2) + "\n");
  const report = renderReport({ unexpected, expected, newDrift, resolved, history });
  if (args.report) fs.writeFileSync(args.report, report);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `drift=${unexpected.length > 0}\nnew_drift=${newDrift.length > 0}\n`);
  return { unexpected, expected, newDrift, resolved, history, report };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "collect") {
    if (!args.environment) throw new Error("--environment is required");
    const snapshot = collectFromAws(args.environment);
    fs.writeFileSync(args.out ?? `${args.environment}.json`, JSON.stringify(snapshot, null, 2) + "\n");
  } else if (command === "compare") {
    const result = runCompare(args);
    console.log(result.report);
    process.exit(result.unexpected.length > 0 ? 2 : 0);
  } else {
    console.error("usage: config-parity-drift.mjs <collect|compare> [options]");
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
