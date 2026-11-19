// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  COMMENT_MARKER,
  compareVersions,
  diffSboms,
  flagDiff,
  isLicenseAllowed,
  lookupVulnerabilities,
  parseSbom,
  renderComment,
  run,
} from "./sbom-diff.mjs";

function sbom(pkgs) {
  return {
    spdxVersion: "SPDX-2.3",
    packages: [
      { SPDXID: "SPDXRef-root", name: "app", versionInfo: "1.0.0" },
      ...pkgs.map(([name, version, license = "MIT"], i) => ({
        SPDXID: `SPDXRef-${i}`,
        name,
        versionInfo: version,
        licenseConcluded: license,
        externalRefs: [{ referenceType: "purl", referenceLocator: `pkg:npm/${name}@${version}` }],
      })),
    ],
    relationships: [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-root" }],
  };
}
const ALLOWED = ["MIT", "Apache-2.0", "ISC", "BSD-3-Clause"];

const base = parseSbom(sbom([["left-pad", "1.0.0"], ["lodash", "4.17.20"], ["gone", "2.0.0"], ["multi", "1.0.0"]]));
const head = parseSbom(
  sbom([
    ["left-pad", "1.0.0"],
    ["lodash", "4.17.21"],
    ["newdep", "0.1.0", "GPL-3.0-only"],
    ["unlicensed", "1.0.0", "NOASSERTION"],
    ["multi", "1.0.0"],
    ["multi", "2.0.0"],
  ])
);

test("root package is excluded and packages are parsed by name and version", () => {
  assert.equal(base.has("app"), false);
  assert.equal(base.get("lodash").get("4.17.20").license, "MIT");
});

test("diff lists added, removed and upgraded packages", () => {
  const d = diffSboms(base, head);
  assert.deepEqual(d.added.map((p) => `${p.name}@${p.version}`), ["multi@2.0.0", "newdep@0.1.0", "unlicensed@1.0.0"]);
  assert.deepEqual(d.removed.map((p) => p.name), ["gone"]);
  assert.deepEqual(d.changed.map((p) => [p.name, p.from, p.to, p.direction]), [["lodash", "4.17.20", "4.17.21", "upgraded"]]);
});

test("downgrades are labeled and identical SBOMs produce no diff", () => {
  const d = diffSboms(head, base);
  assert.equal(d.changed[0].direction, "downgraded");
  const same = diffSboms(base, base);
  assert.deepEqual([same.added, same.removed, same.changed], [[], [], []]);
});

test("compareVersions handles numeric ordering and prereleases", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("v2.0.0", "2.0.0"), 0);
  assert.equal(compareVersions("2.0.0-beta.1", "2.0.0"), -1);
});

test("license expressions: OR needs one allowed side, AND needs both", () => {
  assert.equal(isLicenseAllowed("MIT", ALLOWED), true);
  assert.equal(isLicenseAllowed("GPL-3.0-only", ALLOWED), false);
  assert.equal(isLicenseAllowed("MIT OR GPL-3.0-only", ALLOWED), true);
  assert.equal(isLicenseAllowed("MIT AND GPL-3.0-only", ALLOWED), false);
  assert.equal(isLicenseAllowed("(MIT OR Apache-2.0) AND ISC", ALLOWED), true);
  assert.equal(isLicenseAllowed("(GPL-2.0-only OR AGPL-3.0-only) AND ISC", ALLOWED), false);
});

test("flags disallowed licenses, unknown licenses and known vulnerabilities", () => {
  const vulns = new Map([["pkg:npm/lodash@4.17.21", ["GHSA-xxxx-yyyy-zzzz"]]]);
  const flagged = flagDiff(diffSboms(base, head), { allowedLicenses: ALLOWED, vulnerabilities: vulns });
  const by = Object.fromEntries([...flagged.added, ...flagged.changed].map((e) => [e.name, e.flags]));
  assert.deepEqual(by.newdep, ["disallowed-license"]);
  assert.deepEqual(by.unlicensed, ["unknown-license"]);
  assert.deepEqual(by.lodash, ["vulnerable"]);
  assert.deepEqual(by["multi"], []);
});

test("comment highlights flagged packages and carries the update marker", () => {
  const vulns = new Map([["pkg:npm/lodash@4.17.21", ["GHSA-xxxx-yyyy-zzzz"]]]);
  const md = renderComment([{ name: "backend", diff: flagDiff(diffSboms(base, head), { allowedLicenses: ALLOWED, vulnerabilities: vulns }) }]);
  assert.ok(md.startsWith(COMMENT_MARKER));
  assert.match(md, /3 packages need attention/);
  assert.match(md, /\| newdep \| 0\.1\.0 \| GPL-3\.0-only \| 🚫 disallowed license \|/);
  assert.match(md, /⬆️ 4\.17\.20 → 4\.17\.21/);
  assert.match(md, /GHSA-xxxx-yyyy-zzzz/);
  assert.match(md, /\| Removed \|/);
});

test("comment for an unchanged PR says so", () => {
  const empty = flagDiff(diffSboms(base, base), { allowedLicenses: ALLOWED });
  assert.match(renderComment([{ name: "backend", diff: empty }]), /No dependency changes/);
});

test("OSV lookup maps advisories by purl and tolerates failures", async () => {
  const fetchOk = async (_url, init) => {
    const queries = JSON.parse(init.body).queries;
    return { ok: true, json: async () => ({ results: queries.map((q) => (q.package.purl.includes("lodash") ? { vulns: [{ id: "GHSA-1" }] } : {})) }) };
  };
  const map = await lookupVulnerabilities([{ purl: "pkg:npm/lodash@4.17.21" }, { purl: "pkg:npm/other@1.0.0" }], fetchOk);
  assert.deepEqual([...map], [["pkg:npm/lodash@4.17.21", ["GHSA-1"]]]);
  const broken = await lookupVulnerabilities([{ purl: "pkg:npm/x@1" }], async () => { throw new Error("offline"); });
  assert.equal(broken.size, 0);
});

test("CLI end-to-end writes the comment and reports flagged count", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-"));
  const b = path.join(dir, "base.json");
  const h = path.join(dir, "head.json");
  fs.writeFileSync(b, JSON.stringify(sbom([["a", "1.0.0"]])));
  fs.writeFileSync(h, JSON.stringify(sbom([["a", "1.1.0"], ["b", "1.0.0", "AGPL-3.0-only"]])));
  const out = path.join(dir, "comment.md");
  const origLog = console.log;
  console.log = () => {};
  const result = await run(["--out", out, `backend=${b}:${h}`], { SBOM_DIFF_SKIP_VULN: "true" });
  console.log = origLog;
  assert.equal(result.changed, true);
  assert.equal(result.flagged, 1);
  assert.match(fs.readFileSync(out, "utf8"), /AGPL-3\.0-only/);
});
