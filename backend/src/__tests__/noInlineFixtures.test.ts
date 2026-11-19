// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Ratcheted guard: new tests must use the shared factories rather than
 * building loans, applicants or milestones inline. See
 * docs/TEST_DATA_FACTORIES.md and src/test-utils/inlineFixtureCheck.ts.
 */

import fs from "fs";
import path from "path";
import { findInlineFixtures, listTestFiles } from "../test-utils/inlineFixtureCheck.js";

const SRC_DIR = path.resolve(__dirname, "..");
const BASELINE_PATH = path.resolve(__dirname, "../test-utils/inline-fixture-baseline.json");

// These files legitimately spell out the patterns they police.
const EXEMPT = new Set(["__tests__/noInlineFixtures.test.ts", "__tests__/testFactories.test.ts"]);

const baseline: string[] = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")).files;
const rel = (file: string) => path.relative(SRC_DIR, file).split(path.sep).join("/");

describe("inline fixture guard", () => {
  const results = listTestFiles(SRC_DIR)
    .filter((file) => !EXEMPT.has(rel(file)))
    .map((file) => ({
      file: rel(file),
      hits: findInlineFixtures(fs.readFileSync(file, "utf8")),
    }));

  it("flags inline loan/applicant/milestone fixtures in non-baselined tests", () => {
    const offenders = results.filter((r) => r.hits.length > 0 && !baseline.includes(r.file));
    const report = offenders
      .map((r) => `${r.file}:${r.hits[0].line}  ${r.hits[0].text}`)
      .join("\n");
    expect(offenders.map((r) => r.file)).toEqual([]);
    expect(report).toBe("");
  });

  it("keeps the baseline honest: migrated files must be removed from it", () => {
    const stale = baseline.filter((file) => {
      const result = results.find((r) => r.file === file);
      return !result || result.hits.length === 0;
    });
    expect(stale).toEqual([]);
  });

  it("detects the patterns it is meant to police", () => {
    expect(findInlineFixtures(`const l = { borrowerAddress: "G1" };`)).toHaveLength(1);
    expect(findInlineFixtures(`{ verificationStatus: "ELIGIBLE" }`)).toHaveLength(1);
    expect(findInlineFixtures(`const l = loanFactory.overdue().build();`)).toHaveLength(0);
    // Targeted overrides passed to a factory are the intended pattern.
    expect(
      findInlineFixtures(`loanFactory.build({\n  borrowerAddress: "G1",\n  nested: fn(1),\n});`)
    ).toHaveLength(0);
    expect(findInlineFixtures(`// fixture-ok: asserts raw wire format\n{ borrowerAddress: "G1" }`)).toHaveLength(0);
  });
});
