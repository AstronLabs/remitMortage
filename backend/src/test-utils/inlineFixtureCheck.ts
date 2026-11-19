// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * "Lint rule" discouraging inline fixtures for core entities (loans,
 * applicants, milestones) in tests. Backend has no ESLint toolchain, so the
 * rule is a ratcheted scan run by `noInlineFixtures.test.ts`:
 *
 *   - a test file that builds one of these entities inline fails the scan
 *     unless it is listed in `inline-fixture-baseline.json` (legacy files);
 *   - a baselined file that no longer has inline fixtures must be removed
 *     from the baseline, so the list only ever shrinks;
 *   - a deliberate exception is marked with `// fixture-ok: <reason>`.
 *
 * Use the factories in `test-utils/factories` instead.
 */

import fs from "fs";
import path from "path";

/** Property literals that signal a hand-built loan / applicant / milestone. */
export const INLINE_FIXTURE_PATTERNS: ReadonlyArray<{ name: string; regex: RegExp }> = [
  { name: "borrowerAddress", regex: /\bborrowerAddress\s*:/ },
  { name: "stellarAddress", regex: /\bstellarAddress\s*:/ },
  {
    name: "verificationStatus",
    regex: /\bverificationStatus\s*:\s*["'`](?:ELIGIBLE|PENDING|INELIGIBLE)["'`]/,
  },
  { name: "evidenceCid", regex: /\bevidenceCid\s*:/ },
  { name: "missedPayments", regex: /\bmissedPayments\s*:/ },
];

const OPT_OUT = /fixture-ok\s*:/;

export interface InlineFixtureHit {
  line: number;
  pattern: string;
  text: string;
}

/**
 * Blank out the arguments of factory calls (`.build(...)`, `.with(...)`, ...)
 * so legitimate targeted overrides such as `loanFactory.build({ borrowerAddress })`
 * are not mistaken for inline fixtures. Newlines are kept so line numbers hold.
 */
export function stripFactoryCalls(source: string): string {
  const call = /\.(?:build|buildMany|with|snapshot|forApplicant)\(/g;
  let out = "";
  let cursor = 0;
  for (let m = call.exec(source); m; m = call.exec(source)) {
    if (m.index < cursor) continue;
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
      i++;
    }
    out += source.slice(cursor, m.index + m[0].length);
    out += source.slice(m.index + m[0].length, i - 1).replace(/[^\n]/g, " ");
    cursor = i - 1;
  }
  return out + source.slice(cursor);
}

export function findInlineFixtures(source: string): InlineFixtureHit[] {
  if (OPT_OUT.test(source)) return [];
  const hits: InlineFixtureHit[] = [];
  stripFactoryCalls(source).split("\n").forEach((text, i) => {
    for (const { name, regex } of INLINE_FIXTURE_PATTERNS) {
      if (regex.test(text)) hits.push({ line: i + 1, pattern: name, text: text.trim() });
    }
  });
  return hits;
}

/** Recursively list `*.test.ts(x)` files under `dir`. */
export function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...listTestFiles(full));
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
