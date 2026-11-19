#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
/**
 * Unsafe-merge / unsafe-deserialization lint gate (issue #885).
 *
 * Prototype pollution needs two things: a payload carrying `__proto__`, and a
 * line of code that copies an attacker-controlled key onto an object that
 * already exists. The runtime guards in `backend/src/utils/safeObject.ts` take
 * care of the payload; this gate takes care of the line of code, so a new
 * `Object.assign(existingObject, untrusted)` cannot land without review.
 *
 * Rules (all operate on first-party source only — `__tests__`, `__mocks__`,
 * `node_modules`, `dist` and `.next` are skipped):
 *
 *   unsafe-object-assign   `Object.assign(target, …)` where `target` is not a
 *                          fresh `{}` / `[]` literal or a `new Error(...)`.
 *                          Mutating an object that already exists is the
 *                          pollution sink; building a new one is not.
 *   unsafe-deep-merge      a call to `merge`, `deepMerge`, `deepAssign`,
 *                          `extend`, `defaultsDeep`, `mergeDeep` or
 *                          `setWith`/`_.set` — the classic CVE surface.
 *   unsafe-dynamic-write   `target[userKey] = …` where the key expression
 *                          reads from `req.body` / `req.query` / `req.params`.
 *   unsafe-json-parse      `JSON.parse` applied directly to request, webhook
 *                          or queue text instead of `safeParseJson`.
 *
 * Escape hatches, in order of preference:
 *
 *   1. Use `safeMerge` / `safeAssign` / `safeParseJson` from
 *      `backend/src/utils/safeObject.ts` (or `frontend/src/lib/safe-object.ts`).
 *   2. Put `// safe-merge-ok: <reason>` on the offending line or the line above
 *      it, when the target provably cannot be reached by untrusted keys.
 *
 * Usage:
 *   node scripts/check-unsafe-merge.mjs            # scan the repo, exit 1 on a finding
 *   node scripts/check-unsafe-merge.mjs --json     # machine-readable findings
 *
 * Exit codes: 0 = clean, 1 = at least one unguarded pattern found.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** Directories scanned, relative to the repo root. */
export const SCAN_ROOTS = ["backend/src", "frontend/src", "backend/scripts", "scripts"];

/** Path fragments that are never scanned. */
const SKIP_FRAGMENTS = [
  "node_modules",
  "/dist/",
  "/.next/",
  "/__tests__/",
  "/__mocks__/",
  "/e2e/",
  "/load-tests/",
];

const SKIP_SUFFIXES = [".test.ts", ".test.tsx", ".test.mjs", ".test.js", ".spec.ts", ".spec.tsx"];

const SCAN_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

/** Files exempt by design: the guards themselves, and this gate. */
const SELF_EXEMPT = [
  "backend/src/utils/safeObject.ts",
  "frontend/src/lib/safe-object.ts",
  "scripts/check-unsafe-merge.mjs",
];

/** Inline pragma that waives a finding on this line or the line below it. */
const PRAGMA = /safe-merge-ok:/;

const DEEP_MERGE_CALL =
  /(?<![.\w$])(?:_\.)?(?:deepMerge|mergeDeep|deepAssign|defaultsDeep|setWith|deepExtend)\s*\(/;
const LODASH_MERGE_CALL = /(?<![.\w$])_\.(?:merge|set|assignIn|defaults)\s*\(/;
/** A bare `merge(a, b)` / `extend(a, b)` call, but not `safeMerge(` or `.merge(`. */
const BARE_MERGE_CALL = /(?<![.\w$])(?:merge|extend)\s*\(/;

const OBJECT_ASSIGN_CALL = /Object\.assign\s*\(/;
/** `Object.assign({…}`, `Object.assign([…`, `Object.assign(new Error(` are safe. */
const SAFE_ASSIGN_TARGET = /Object\.assign\s*\(\s*(?:\{|\[|new\s+[A-Z]\w*\s*\()/;

const DYNAMIC_WRITE =
  /\[\s*(?:[A-Za-z_$][\w$]*\s*)?(?:req|request)\s*(?:\.\w+|\?\.\w+|\[[^\]]+\])*\s*(?:\.\w+|\[[^\]]+\])\s*\]\s*=[^=]/;

/** The first argument of a `JSON.parse(...)` call, up to the first `,` or `)`. */
const JSON_PARSE_ARGUMENT = /JSON\.parse\s*\(([^),]*)/;
/**
 * Identifiers that name data this process did not produce: an HTTP request, a
 * WebSocket/SSE/postMessage event, an XHR response, a queue job, a webhook
 * body. `localStorage.getItem(...)` and `fs.readFileSync(...)` do not match.
 */
const UNTRUSTED_PARSE_SOURCE =
  /(?:^|[^\w$.])(?:req|request|event|evt|message|msg|xhr|responseText|rawBody|rawPayload|payloadText|bodyText|messageBody|jobData|queueMessage|webhookBody)(?:[^\w$]|$)/;

function parsesUntrustedText(line) {
  const match = JSON_PARSE_ARGUMENT.exec(line);
  if (!match) return false;
  return UNTRUSTED_PARSE_SOURCE.test(match[1]);
}

export const RULES = [
  {
    id: "unsafe-object-assign",
    test: (line) => OBJECT_ASSIGN_CALL.test(line) && !SAFE_ASSIGN_TARGET.test(line),
    message:
      "Object.assign() into an existing object copies attacker-controlled keys — use safeAssign()/safeMerge(), or Object.assign({}, …) to build a new object",
  },
  {
    id: "unsafe-deep-merge",
    test: (line) =>
      DEEP_MERGE_CALL.test(line) || LODASH_MERGE_CALL.test(line) || BARE_MERGE_CALL.test(line),
    message:
      "hand-rolled or lodash deep merge is the classic prototype-pollution sink — use safeMerge()",
  },
  {
    id: "unsafe-dynamic-write",
    test: (line) => DYNAMIC_WRITE.test(line),
    message:
      "writing to a key taken straight from the request lets a caller pick the property name — validate the key against an allowlist first",
  },
  {
    id: "unsafe-json-parse",
    test: (line) => parsesUntrustedText(line),
    message:
      "JSON.parse() on untrusted text yields a live `__proto__` own property — use safeParseJson()",
  },
];

/** True when `relPath` is outside the scan scope. */
export function isSkipped(relPath) {
  const normalized = `/${relPath.split(path.sep).join("/")}`;
  if (SKIP_FRAGMENTS.some((fragment) => normalized.includes(fragment))) return true;
  if (SKIP_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) return true;
  if (SELF_EXEMPT.some((exempt) => normalized.endsWith(`/${exempt}`))) return true;
  return !SCAN_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

/** Strips `//` comments and string literals so a pattern in prose is not a finding. */
function codeOnly(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/\*.*$/, "")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

/**
 * Scans one file's text and returns the findings in it.
 *
 * @param {string} source   File contents.
 * @param {string} relPath  Path reported in the finding.
 * @returns {Array<{file: string, line: number, rule: string, message: string, text: string}>}
 */
export function scanSource(source, relPath) {
  const lines = source.split(/\r?\n/);
  const findings = [];

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    // A pragma on the line itself or on the line directly above waives it.
    if (PRAGMA.test(raw) || (index > 0 && PRAGMA.test(lines[index - 1]))) continue;

    const line = codeOnly(raw);
    if (line.trim() === "") continue;

    for (const rule of RULES) {
      if (!rule.test(line)) continue;
      findings.push({
        file: relPath,
        line: index + 1,
        rule: rule.id,
        message: rule.message,
        text: raw.trim(),
      });
    }
  }

  return findings;
}

function walkDirectory(absoluteDir, repoRoot, out) {
  if (!fs.existsSync(absoluteDir)) return out;
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = path.relative(repoRoot, absolute);
    if (entry.isDirectory()) {
      if (isSkipped(`${relative}${path.sep}x.ts`)) continue;
      walkDirectory(absolute, repoRoot, out);
      continue;
    }
    if (isSkipped(relative)) continue;
    out.push(absolute);
  }
  return out;
}

/** Collects every scannable file under {@link SCAN_ROOTS}. */
export function collectFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const files = [];
  for (const root of roots) walkDirectory(path.join(repoRoot, root), repoRoot, files);
  return files.sort();
}

/** Scans the repository and returns every finding. */
export function runCheck(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
  const findings = [];
  for (const absolute of collectFiles(repoRoot, roots)) {
    const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");
    findings.push(...scanSource(fs.readFileSync(absolute, "utf8"), relative));
  }
  return findings;
}

function main(argv) {
  const findings = runCheck();

  if (argv.includes("--json")) {
    console.log(JSON.stringify({ findings }, null, 2));
    return findings.length === 0 ? 0 : 1;
  }

  if (findings.length === 0) {
    console.log("[check-unsafe-merge] OK — no unguarded merge or deserialization patterns found.");
    return 0;
  }

  console.error(`[check-unsafe-merge] ${findings.length} unguarded pattern(s) found:\n`);
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  [${finding.rule}]`);
    console.error(`    ${finding.text}`);
    console.error(`    → ${finding.message}\n`);
    // GitHub annotation so the finding shows up inline on the pull request.
    console.error(
      `::error file=${finding.file},line=${finding.line}::[${finding.rule}] ${finding.message}`
    );
  }
  console.error(
    "Fix with safeMerge/safeAssign/safeParseJson, or waive one line with `// safe-merge-ok: <reason>`."
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
