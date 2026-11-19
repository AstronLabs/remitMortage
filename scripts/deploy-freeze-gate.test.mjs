// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  evaluateGate,
  expandWindows,
  findActiveFreeze,
  formatAnnouncement,
  loadCalendar,
  runCheck,
  upcomingFreezes,
  validateCalendar,
} from "./deploy-freeze-gate.mjs";

const calendar = {
  authorizedOverriders: ["alice"],
  minOverrideReasonLength: 15,
  monthEnd: { enabled: true, lastDays: 2, environments: ["production"], reason: "Month-end processing" },
  windows: [
    {
      id: "incident",
      name: "Incident hold",
      reason: "Active incident",
      start: "2026-03-10T12:00:00Z",
      end: "2026-03-10T18:00:00Z",
      environments: ["production"],
    },
    {
      id: "hard",
      name: "Hard freeze",
      reason: "Audit",
      start: "2026-06-01T00:00:00Z",
      end: "2026-06-02T00:00:00Z",
      environments: ["production"],
      allowOverride: false,
    },
  ],
};
const at = (iso) => new Date(iso);

test("window start is inclusive and end is exclusive", () => {
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-10T11:59:59Z")), null);
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-10T12:00:00Z")).id, "incident");
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-10T17:59:59Z")).id, "incident");
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-10T18:00:00Z")), null);
});

test("freezes only apply to the listed environments", () => {
  assert.equal(findActiveFreeze(calendar, "staging", at("2026-03-10T13:00:00Z")), null);
});

test("month-end window covers the last N days and ends at the 1st", () => {
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-29T23:59:59Z")), null);
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-30T00:00:00Z")).id, "month-end-2026-03");
  assert.equal(findActiveFreeze(calendar, "production", at("2026-03-31T23:59:59Z")).id, "month-end-2026-03");
  assert.equal(findActiveFreeze(calendar, "production", at("2026-04-01T00:00:00Z")), null);
});

test("month-end handles February in leap and non-leap years and year rollover", () => {
  assert.equal(findActiveFreeze(calendar, "production", at("2028-02-28T00:00:00Z")).id, "month-end-2028-02");
  assert.equal(findActiveFreeze(calendar, "production", at("2027-02-27T12:00:00Z")).id, "month-end-2027-02");
  assert.equal(findActiveFreeze(calendar, "production", at("2026-12-31T10:00:00Z")).id, "month-end-2026-12");
  assert.equal(findActiveFreeze(calendar, "production", at("2027-01-01T00:00:00Z")), null);
});

test("deploy outside any freeze is open", () => {
  const r = evaluateGate({ calendar, environment: "production", now: at("2026-03-15T10:00:00Z") });
  assert.deepEqual([r.allowed, r.status], [true, "open"]);
});

test("production deploy during a freeze is blocked without an override", () => {
  const r = evaluateGate({ calendar, environment: "production", now: at("2026-03-10T13:00:00Z"), actor: "alice" });
  assert.deepEqual([r.allowed, r.status], [false, "blocked"]);
  assert.match(r.message, /frozen/);
});

test("authorized override with a reason is allowed and recorded with person and reason", () => {
  const r = evaluateGate({
    calendar, environment: "production", now: at("2026-03-10T13:00:00Z"),
    actor: "Alice", reason: "Hotfix for payment outage INC-42",
  });
  assert.equal(r.allowed, true);
  assert.equal(r.status, "override");
  assert.deepEqual(r.override, {
    actor: "Alice", reason: "Hotfix for payment outage INC-42", windowId: "incident", at: "2026-03-10T13:00:00.000Z",
  });
});

test("override is rejected for unauthorized actors, short reasons and hard freezes", () => {
  const now = at("2026-03-10T13:00:00Z");
  const long = "Hotfix for payment outage INC-42";
  assert.equal(evaluateGate({ calendar, environment: "production", now, actor: "mallory", reason: long }).allowed, false);
  assert.equal(evaluateGate({ calendar, environment: "production", now, actor: "alice", reason: "urgent" }).allowed, false);
  assert.equal(evaluateGate({ calendar, environment: "production", now, actor: "", reason: long }).allowed, false);
  const hard = evaluateGate({ calendar, environment: "production", now: at("2026-06-01T05:00:00Z"), actor: "alice", reason: long });
  assert.equal(hard.allowed, false);
  assert.match(hard.message, /does not allow overrides/);
});

test("upcoming freezes list active and soon-to-start windows in order", () => {
  const list = upcomingFreezes(calendar, at("2026-03-10T10:00:00Z"), 72);
  assert.deepEqual(list.map((f) => f.id), ["incident"]);
  const later = upcomingFreezes(calendar, at("2026-03-28T00:00:00Z"), 72);
  assert.deepEqual(later.map((f) => f.id), ["month-end-2026-03"]);
  assert.match(formatAnnouncement(later), /Month-end freeze/);
  assert.equal(formatAnnouncement([]), null);
});

test("expandWindows excludes windows entirely in the past or beyond the range", () => {
  const ids = expandWindows(calendar, at("2026-04-02T00:00:00Z").getTime(), at("2026-04-03T00:00:00Z").getTime()).map((w) => w.id);
  assert.deepEqual(ids, []);
});

test("validateCalendar flags bad calendars and accepts the committed one", () => {
  assert.deepEqual(validateCalendar(calendar), []);
  const bad = { authorizedOverriders: [], windows: [{ id: "x", start: "nope", end: "2026-01-01T00:00:00Z", environments: [], reason: "" }] };
  assert.ok(validateCalendar(bad).length >= 3);
  assert.deepEqual(validateCalendar(loadCalendar()), []);
});

test("runCheck blocks, logs overrides to the override log, and reports open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeze-"));
  const calPath = path.join(dir, "cal.json");
  const logPath = path.join(dir, "log.jsonl");
  fs.writeFileSync(calPath, JSON.stringify(calendar));
  const base = { FREEZE_CALENDAR_PATH: calPath, FREEZE_OVERRIDE_LOG_PATH: logPath, ENVIRONMENT: "production", FREEZE_NOW: "2026-03-10T13:00:00Z" };

  const blocked = await runCheck({ ...base, DEPLOY_ACTOR: "alice" });
  assert.equal(blocked.allowed, false);
  assert.equal(fs.existsSync(logPath), false);

  const ok = await runCheck({ ...base, DEPLOY_ACTOR: "alice", FREEZE_OVERRIDE_REASON: "Hotfix for payment outage INC-42" });
  assert.equal(ok.allowed, true);
  const logged = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
  assert.equal(logged.actor, "alice");
  assert.equal(logged.reason, "Hotfix for payment outage INC-42");

  const open = await runCheck({ ...base, FREEZE_NOW: "2026-03-15T00:00:00Z" });
  assert.equal(open.status, "open");
});
