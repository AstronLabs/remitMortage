// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
/**
 * Tests for the unsafe-merge lint gate (issue #885).
 *
 * Run with: node --test scripts/check-unsafe-merge.test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isSkipped, runCheck, scanSource } from "./check-unsafe-merge.mjs";

function rules(findings) {
  return findings.map((finding) => finding.rule);
}

// ── unsafe-object-assign ─────────────────────────────────────────────────

test("flags Object.assign into an existing object", () => {
  const findings = scanSource(
    `export function apply(settings, incoming) {\n  Object.assign(settings, incoming);\n  return settings;\n}\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(rules(findings), ["unsafe-object-assign"]);
  assert.equal(findings[0].line, 2);
  assert.match(findings[0].message, /safeAssign/);
});

test("allows Object.assign that builds a fresh object", () => {
  const findings = scanSource(
    `const merged = Object.assign({}, defaults, incoming);\nconst copy = Object.assign([], list);\nconst err = Object.assign(new Error("x"), { code: "P2002" });\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

// ── unsafe-deep-merge ────────────────────────────────────────────────────

test("flags hand-rolled and lodash deep merges", () => {
  const cases = [
    "deepMerge(target, body);",
    "mergeDeep(state, payload);",
    "_.merge(config, incoming);",
    "_.set(config, key, value);",
    "defaultsDeep(options, overrides);",
    "merge(existing, patch);",
    "extend(existing, patch);",
  ];

  for (const line of cases) {
    const findings = scanSource(`${line}\n`, "backend/src/services/example.ts");
    assert.deepEqual(rules(findings), ["unsafe-deep-merge"], `expected a finding for: ${line}`);
  }
});

test("does not flag the sanctioned helpers", () => {
  const findings = scanSource(
    `safeMerge(settings, req.body);\nsafeAssign(settings, patch);\nconst parsed = safeParseJson(rawBody);\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

test("does not flag a method named merge on a receiver", () => {
  const findings = scanSource(
    `const next = store.merge(patch);\nawait queue.extend(job);\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

// ── unsafe-dynamic-write ─────────────────────────────────────────────────

test("flags a property write keyed by request data", () => {
  const findings = scanSource(
    `target[req.body.field] = value;\n`,
    "backend/src/routes/example.ts"
  );

  assert.deepEqual(rules(findings), ["unsafe-dynamic-write"]);
});

test("allows a property write keyed by a validated local", () => {
  const findings = scanSource(
    `const field = allowlist[index];\ntarget[field] = value;\n`,
    "backend/src/routes/example.ts"
  );

  assert.deepEqual(findings, []);
});

// ── unsafe-json-parse ────────────────────────────────────────────────────

test("flags JSON.parse on untrusted text", () => {
  for (const line of ["JSON.parse(req.body.payload);", "const data = JSON.parse(rawBody);"]) {
    const findings = scanSource(`${line}\n`, "backend/src/services/example.ts");
    assert.deepEqual(rules(findings), ["unsafe-json-parse"], `expected a finding for: ${line}`);
  }
});

test("allows JSON.parse of first-party text", () => {
  const findings = scanSource(
    `const config = JSON.parse(fs.readFileSync(configPath, "utf8"));\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

// ── waivers, comments and strings ────────────────────────────────────────

test("an inline pragma waives the finding on that line", () => {
  const findings = scanSource(
    `Object.assign(error, { code }); // safe-merge-ok: literal keys only\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

test("a pragma on the preceding line waives the finding", () => {
  const findings = scanSource(
    `// safe-merge-ok: target is a fresh clone\nObject.assign(clone, incoming);\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

test("a pattern inside a comment or a string is not a finding", () => {
  const findings = scanSource(
    `// never write Object.assign(target, body)\nconst hint = "use deepMerge(a, b) at your peril";\n`,
    "backend/src/services/example.ts"
  );

  assert.deepEqual(findings, []);
});

// ── scope ────────────────────────────────────────────────────────────────

test("tests, mocks and build output are out of scope", () => {
  for (const file of [
    "backend/src/__tests__/example.test.ts",
    "backend/src/services/example.test.ts",
    "frontend/__mocks__/example.ts",
    "backend/dist/services/example.js",
    "backend/node_modules/pkg/index.js",
    "docs/EXAMPLE.md",
  ]) {
    assert.equal(isSkipped(file), true, `expected ${file} to be skipped`);
  }

  assert.equal(isSkipped("backend/src/services/example.ts"), false);
  assert.equal(isSkipped("frontend/src/lib/example.tsx"), false);
});

test("the guard helpers themselves are exempt", () => {
  assert.equal(isSkipped("backend/src/utils/safeObject.ts"), true);
  assert.equal(isSkipped("frontend/src/lib/safe-object.ts"), true);
});

// ── end-to-end over a scratch tree ───────────────────────────────────────

test("runCheck reports an unguarded merge in a scanned tree and nothing in a clean one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "unsafe-merge-"));
  const sourceDir = path.join(root, "backend", "src", "services");
  fs.mkdirSync(sourceDir, { recursive: true });

  fs.writeFileSync(
    path.join(sourceDir, "clean.ts"),
    `import { safeMerge } from "../utils/safeObject.js";\nexport const apply = (a, b) => safeMerge(a, b);\n`
  );
  assert.deepEqual(runCheck(root, ["backend/src"]), []);

  fs.writeFileSync(
    path.join(sourceDir, "dirty.ts"),
    `export const apply = (a, b) => Object.assign(a, b);\n`
  );
  const findings = runCheck(root, ["backend/src"]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, "unsafe-object-assign");
  assert.equal(findings[0].file, "backend/src/services/dirty.ts");

  fs.rmSync(root, { recursive: true, force: true });
});

test("the repository itself is clean", () => {
  assert.deepEqual(
    runCheck(),
    [],
    "scripts/check-unsafe-merge.mjs found an unguarded merge in first-party source"
  );
});
