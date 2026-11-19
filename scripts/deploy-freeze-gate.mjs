// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Deployment freeze gate (issue #930).
 *
 * Reads the version-controlled calendar in devops/deploy-freeze-calendar.json
 * and blocks production deploys that fall inside a freeze window, unless an
 * authorized person supplies an override with a reason. Every override is
 * recorded (person + reason + window) so it can be audited afterwards.
 *
 * Windows are half-open: active from `start` (inclusive) to `end` (exclusive).
 * A `monthEnd` rule adds a recurring freeze over the last N days of each month.
 *
 * Usage:
 *   node scripts/deploy-freeze-gate.mjs check     # gate a deploy (exit 1 = blocked)
 *   node scripts/deploy-freeze-gate.mjs announce  # post upcoming freezes to the team channel
 *   node scripts/deploy-freeze-gate.mjs validate  # lint the calendar
 *
 * Env: ENVIRONMENT, DEPLOY_ACTOR, FREEZE_OVERRIDE_REASON, FREEZE_CALENDAR_PATH,
 *      FREEZE_NOW (ISO, tests/dry runs), FREEZE_ANNOUNCE_HOURS (default 72),
 *      DEVOPS_ALERT_WEBHOOK_URL, FREEZE_OVERRIDE_LOG_PATH, GITHUB_OUTPUT,
 *      GITHUB_STEP_SUMMARY.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_CALENDAR = "devops/deploy-freeze-calendar.json";
const DEFAULT_MIN_REASON = 15;

export function loadCalendar(path = DEFAULT_CALENDAR) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

/** Returns a list of problems with the calendar (empty = valid). */
export function validateCalendar(calendar) {
  const problems = [];
  if (!calendar || typeof calendar !== "object") return ["calendar must be an object"];
  if (!Array.isArray(calendar.authorizedOverriders)) problems.push("authorizedOverriders must be an array");
  const ids = new Set();
  for (const [i, w] of (calendar.windows ?? []).entries()) {
    const label = w?.id ?? `windows[${i}]`;
    if (!w?.id) problems.push(`${label}: id is required`);
    else if (ids.has(w.id)) problems.push(`${label}: duplicate id`);
    ids.add(w?.id);
    const start = Date.parse(w?.start);
    const end = Date.parse(w?.end);
    if (Number.isNaN(start)) problems.push(`${label}: start is not a valid date`);
    if (Number.isNaN(end)) problems.push(`${label}: end is not a valid date`);
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) problems.push(`${label}: end must be after start`);
    if (!Array.isArray(w?.environments) || w.environments.length === 0) problems.push(`${label}: environments must be a non-empty array`);
    if (!w?.reason) problems.push(`${label}: reason is required`);
  }
  if (calendar.monthEnd?.enabled) {
    const d = calendar.monthEnd.lastDays;
    if (!Number.isInteger(d) || d < 1 || d > 28) problems.push("monthEnd.lastDays must be an integer between 1 and 28");
  }
  return problems;
}

/** Month-end windows overlapping [fromMs, toMs]. */
function monthEndWindows(rule, fromMs, toMs) {
  if (!rule?.enabled) return [];
  const out = [];
  const from = new Date(fromMs);
  let year = from.getUTCFullYear();
  let month = from.getUTCMonth() - 1; // include the previous month's tail
  for (let i = 0; i < 4; i++, month++) {
    const startOfNext = Date.UTC(year, month + 1, 1);
    const start = startOfNext - rule.lastDays * 86_400_000;
    if (start > toMs) break;
    if (startOfNext > fromMs) {
      const y = new Date(startOfNext - 1).getUTCFullYear();
      const m = new Date(startOfNext - 1).getUTCMonth() + 1;
      out.push({
        id: `month-end-${y}-${String(m).padStart(2, "0")}`,
        name: "Month-end freeze",
        reason: rule.reason ?? "Month-end processing",
        start: new Date(start).toISOString(),
        end: new Date(startOfNext).toISOString(),
        environments: rule.environments ?? ["production"],
        allowOverride: rule.allowOverride !== false,
      });
    }
  }
  return out;
}

/** All explicit + recurring windows overlapping [fromMs, toMs]. */
export function expandWindows(calendar, fromMs, toMs) {
  const explicit = (calendar.windows ?? []).filter(
    (w) => Date.parse(w.end) > fromMs && Date.parse(w.start) <= toMs
  );
  return [...explicit, ...monthEndWindows(calendar.monthEnd, fromMs, toMs)];
}

export function findActiveFreeze(calendar, environment, now) {
  const t = now.getTime();
  return (
    expandWindows(calendar, t, t).find(
      (w) =>
        w.environments.includes(environment) && Date.parse(w.start) <= t && t < Date.parse(w.end)
    ) ?? null
  );
}

/** Freezes starting within the next `hours` (or already active) for any environment. */
export function upcomingFreezes(calendar, now, hours = 72) {
  const t = now.getTime();
  return expandWindows(calendar, t, t + hours * 3_600_000)
    .map((w) => ({ ...w, active: Date.parse(w.start) <= t }))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/**
 * Decide whether a deploy may proceed.
 *   status "open"     - no freeze applies
 *   status "override" - freeze applies but an authorized override was recorded
 *   status "blocked"  - freeze applies and no valid override
 */
export function evaluateGate({ calendar, environment, now = new Date(), actor = "", reason = "" }) {
  const freeze = findActiveFreeze(calendar, environment, now);
  if (!freeze) return { allowed: true, status: "open", environment, checkedAt: now.toISOString() };

  const base = { environment, checkedAt: now.toISOString(), freeze };
  const trimmedReason = String(reason ?? "").trim();
  const trimmedActor = String(actor ?? "").trim();
  const minReason = calendar.minOverrideReasonLength ?? DEFAULT_MIN_REASON;

  if (!trimmedReason) {
    return { ...base, allowed: false, status: "blocked", message: `Deploy to ${environment} is frozen (${freeze.name}: ${freeze.reason}) until ${freeze.end}. Provide an emergency override with a reason if this is an emergency.` };
  }
  if (freeze.allowOverride === false) {
    return { ...base, allowed: false, status: "blocked", message: `${freeze.name} does not allow overrides. Wait until ${freeze.end}.` };
  }
  const authorized = (calendar.authorizedOverriders ?? []).some(
    (a) => a.toLowerCase() === trimmedActor.toLowerCase()
  );
  if (!authorized) {
    return { ...base, allowed: false, status: "blocked", message: `${trimmedActor || "unknown actor"} is not authorized to override the deploy freeze.` };
  }
  if (trimmedReason.length < minReason) {
    return { ...base, allowed: false, status: "blocked", message: `Override reason must be at least ${minReason} characters.` };
  }
  return {
    ...base,
    allowed: true,
    status: "override",
    override: { actor: trimmedActor, reason: trimmedReason, windowId: freeze.id, at: now.toISOString() },
    message: `Freeze "${freeze.name}" overridden by ${trimmedActor}: ${trimmedReason}`,
  };
}

export function formatStatus(result) {
  if (result.status === "open") return `🟢 No deploy freeze in effect for ${result.environment}.`;
  if (result.status === "override") return `🟠 Deploy freeze overridden by ${result.override.actor}. Reason: ${result.override.reason}`;
  return `🔴 ${result.message}`;
}

export function formatAnnouncement(freezes, now = new Date()) {
  if (freezes.length === 0) return null;
  const lines = freezes.map(
    (f) =>
      `• ${f.active ? "ACTIVE NOW" : "Upcoming"}: *${f.name}* (${f.environments.join(", ")}) ${f.start} → ${f.end} — ${f.reason}`
  );
  return `❄️ Deployment freeze notice (${now.toISOString()})\n${lines.join("\n")}\nProduction deploys are blocked in these windows unless an authorized emergency override is recorded.`;
}

async function postWebhook(url, text) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function writeOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
}

function writeSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

export async function runCheck(env = process.env) {
  const calendar = loadCalendar(env.FREEZE_CALENDAR_PATH ?? DEFAULT_CALENDAR);
  const now = env.FREEZE_NOW ? new Date(env.FREEZE_NOW) : new Date();
  const result = evaluateGate({
    calendar,
    environment: env.ENVIRONMENT ?? "production",
    now,
    actor: env.DEPLOY_ACTOR ?? "",
    reason: env.FREEZE_OVERRIDE_REASON ?? "",
  });
  console.log(formatStatus(result));
  writeSummary(`### Deploy freeze status\n${formatStatus(result)}`);
  writeOutputs({ status: result.status, allowed: String(result.allowed) });

  if (result.status === "override") {
    const logPath = env.FREEZE_OVERRIDE_LOG_PATH ?? "freeze-override-log.jsonl";
    fs.appendFileSync(logPath, `${JSON.stringify(result.override)}\n`);
    await postWebhook(
      env.DEVOPS_ALERT_WEBHOOK_URL,
      `🟠 Deploy freeze override: ${result.override.actor} deploying to ${result.environment} during "${result.freeze.name}". Reason: ${result.override.reason}`
    );
  } else if (result.status === "blocked") {
    console.error(`::error::${result.message}`);
  }
  return result;
}

export async function runAnnounce(env = process.env) {
  const calendar = loadCalendar(env.FREEZE_CALENDAR_PATH ?? DEFAULT_CALENDAR);
  const now = env.FREEZE_NOW ? new Date(env.FREEZE_NOW) : new Date();
  const message = formatAnnouncement(upcomingFreezes(calendar, now, Number(env.FREEZE_ANNOUNCE_HOURS ?? 72)), now);
  if (!message) {
    console.log("No upcoming deployment freezes.");
    return null;
  }
  console.log(message);
  writeSummary(`### Upcoming deploy freezes\n${message}`);
  await postWebhook(env.DEVOPS_ALERT_WEBHOOK_URL, message);
  return message;
}

async function main() {
  const command = process.argv[2];
  if (command === "check") {
    const result = await runCheck();
    process.exit(result.allowed ? 0 : 1);
  } else if (command === "announce") {
    await runAnnounce();
  } else if (command === "validate") {
    const problems = validateCalendar(loadCalendar(process.env.FREEZE_CALENDAR_PATH ?? DEFAULT_CALENDAR));
    problems.forEach((p) => console.error(`::error::${p}`));
    process.exit(problems.length ? 1 : 0);
  } else {
    console.error("usage: deploy-freeze-gate.mjs <check|announce|validate>");
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
