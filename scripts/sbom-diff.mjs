// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * SBOM diff for pull requests (issue #929).
 *
 * Compares the SPDX-JSON SBOM generated for the PR head against the one for
 * the base branch and renders a concise markdown comment listing added,
 * removed and upgraded/downgraded packages with their licenses. Added or
 * changed packages are flagged when their license is outside
 * scripts/license-allowlist.json or when OSV reports known vulnerabilities.
 *
 * Usage:
 *   node scripts/sbom-diff.mjs --out comment.md [--fail-on-flagged] \
 *     backend=base-backend.json:head-backend.json frontend=base-fe.json:head-fe.json
 *
 * Env: SBOM_DIFF_SKIP_VULN=true to skip the OSV lookup (offline runs).
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

export const COMMENT_MARKER = "<!-- sbom-diff-comment -->";
const UNKNOWN_LICENSE = "NOASSERTION";

// ---------------------------------------------------------------------------
// SBOM parsing
// ---------------------------------------------------------------------------

function purlOf(pkg) {
  return (pkg.externalRefs ?? []).find((r) => r.referenceType === "purl")?.referenceLocator ?? null;
}

function normalizeLicense(pkg) {
  const concluded = pkg.licenseConcluded;
  const declared = pkg.licenseDeclared;
  const pick = [concluded, declared].find((l) => l && l !== "NOASSERTION" && l !== "NONE");
  return pick ?? UNKNOWN_LICENSE;
}

/** Map of package name -> Map(version -> { license, purl }), excluding the document's root packages. */
export function parseSbom(sbom) {
  const roots = new Set(
    (sbom.relationships ?? [])
      .filter((r) => r.relationshipType === "DESCRIBES")
      .map((r) => r.relatedSpdxElement)
  );
  const out = new Map();
  for (const pkg of sbom.packages ?? []) {
    if (roots.has(pkg.SPDXID) || !pkg.name) continue;
    const version = pkg.versionInfo ?? "";
    if (!out.has(pkg.name)) out.set(pkg.name, new Map());
    out.get(pkg.name).set(version, { license: normalizeLicense(pkg), purl: purlOf(pkg) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Versions and licenses
// ---------------------------------------------------------------------------

/** Numeric dotted compare, ignoring a leading "v" and any pre-release suffix ordering beyond presence. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = String(v).replace(/^v/, "").split(/-(.+)/);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return 0;
}

const maxVersion = (versions) => [...versions].sort(compareVersions).at(-1);

/** True when the SPDX expression is satisfiable using only allowed licenses. */
export function isLicenseAllowed(expression, allowed) {
  const allow = new Set(allowed);
  const evalExpr = (expr) => {
    const e = expr.trim().replace(/^\((.*)\)$/s, "$1");
    // Split on top-level OR first (lowest precedence), then AND.
    const split = (s, op) => {
      const parts = [];
      let depth = 0;
      let cur = "";
      for (const tok of s.split(/(\s+)/)) {
        if (tok === "(") depth++;
        depth += (tok.match(/\(/g) ?? []).length - (tok.match(/\)/g) ?? []).length;
        if (depth === 0 && tok === op) {
          parts.push(cur);
          cur = "";
        } else cur += tok;
      }
      parts.push(cur);
      return parts;
    };
    const ors = split(e, "OR");
    if (ors.length > 1) return ors.some(evalExpr);
    const ands = split(e, "AND");
    if (ands.length > 1) return ands.every(evalExpr);
    return allow.has(e.replace(/\+$/, "").replace(/^\(|\)$/g, "").trim());
  };
  return evalExpr(String(expression));
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Compute added / removed / changed packages between two parsed SBOMs. */
export function diffSboms(base, head) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, versions] of head) {
    const before = base.get(name);
    if (!before) {
      for (const [version, info] of versions) added.push({ name, version, ...info });
      continue;
    }
    const gone = [...before.keys()].filter((v) => !versions.has(v));
    const fresh = [...versions.keys()].filter((v) => !before.has(v));
    if (gone.length === 0 && fresh.length === 0) continue;
    if (gone.length && fresh.length) {
      const from = maxVersion(gone);
      const to = maxVersion(fresh);
      const direction = compareVersions(to, from) >= 0 ? "upgraded" : "downgraded";
      const info = versions.get(to);
      changed.push({
        name,
        from,
        to,
        direction,
        license: info.license,
        previousLicense: before.get(from).license,
        purl: info.purl,
      });
    } else if (fresh.length) {
      for (const v of fresh) added.push({ name, version: v, ...versions.get(v) });
    } else {
      for (const v of gone) removed.push({ name, version: v, ...before.get(v) });
    }
  }
  for (const [name, versions] of base) {
    if (head.has(name)) continue;
    for (const [version, info] of versions) removed.push({ name, version, ...info });
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { added: added.sort(byName), removed: removed.sort(byName), changed: changed.sort(byName) };
}

/** Annotate added/changed packages with license and vulnerability flags. */
export function flagDiff(diff, { allowedLicenses, vulnerabilities = new Map() }) {
  const flag = (entry, version) => {
    const flags = [];
    if (entry.license === UNKNOWN_LICENSE) flags.push("unknown-license");
    else if (!isLicenseAllowed(entry.license, allowedLicenses)) flags.push("disallowed-license");
    const vulns = vulnerabilities.get(entry.purl ?? `${entry.name}@${version}`) ?? [];
    if (vulns.length) flags.push("vulnerable");
    return { ...entry, flags, vulnerabilities: vulns };
  };
  return {
    added: diff.added.map((e) => flag(e, e.version)),
    removed: diff.removed,
    changed: diff.changed.map((e) => flag(e, e.to)),
  };
}

/** Query OSV for known vulnerabilities; returns Map(purl -> [advisory ids]). Failures yield an empty map. */
export async function lookupVulnerabilities(entries, fetchImpl = fetch) {
  const purls = [...new Set(entries.map((e) => e.purl).filter(Boolean))];
  const result = new Map();
  for (let i = 0; i < purls.length; i += 500) {
    const chunk = purls.slice(i, i + 500);
    try {
      const res = await fetchImpl("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: chunk.map((purl) => ({ package: { purl } })) }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      (data.results ?? []).forEach((r, idx) => {
        const ids = (r.vulns ?? []).map((v) => v.id);
        if (ids.length) result.set(chunk[idx], ids);
      });
    } catch {
      // Network issues must not break the PR; the comment simply omits vuln data.
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const FLAG_TEXT = {
  "disallowed-license": "🚫 disallowed license",
  "unknown-license": "⚠️ unknown license",
  vulnerable: "🛑 known vulnerabilities",
};

function flagCell(entry) {
  const parts = entry.flags.map((f) => FLAG_TEXT[f]);
  if (entry.vulnerabilities?.length) {
    const shown = entry.vulnerabilities.slice(0, 3).join(", ");
    parts.push(`(${shown}${entry.vulnerabilities.length > 3 ? ", …" : ""})`);
  }
  return parts.join(" ");
}

const esc = (s) => String(s).replace(/\|/g, "\\|");

export function hasChanges(d) {
  return d.added.length + d.removed.length + d.changed.length > 0;
}

export function countFlagged(d) {
  return [...d.added, ...d.changed].filter((e) => e.flags.length > 0).length;
}

/** @param components Array<{ name, diff }> (diff already flagged) */
export function renderComment(components) {
  const lines = [COMMENT_MARKER, "## 📦 SBOM dependency changes", ""];
  const changed = components.filter((c) => hasChanges(c.diff));
  if (changed.length === 0) {
    lines.push("No dependency changes in this pull request.");
    return lines.join("\n") + "\n";
  }
  const flagged = changed.reduce((n, c) => n + countFlagged(c.diff), 0);
  lines.push(
    flagged > 0
      ? `**⚠️ ${flagged} package${flagged === 1 ? "" : "s"} need attention** (disallowed/unknown license or known vulnerability).`
      : "No license or vulnerability concerns found."
  );
  lines.push("");
  for (const { name, diff } of changed) {
    lines.push(`### ${name}`, "");
    lines.push(`+${diff.added.length} added · −${diff.removed.length} removed · ↕${diff.changed.length} changed`, "");
    if (diff.added.length) {
      lines.push("| Added | Version | License | Flags |", "| --- | --- | --- | --- |");
      for (const e of diff.added) lines.push(`| ${esc(e.name)} | ${esc(e.version)} | ${esc(e.license)} | ${flagCell(e)} |`);
      lines.push("");
    }
    if (diff.changed.length) {
      lines.push("| Changed | Version | License | Flags |", "| --- | --- | --- | --- |");
      for (const e of diff.changed) {
        const arrow = e.direction === "upgraded" ? "⬆️" : "⬇️";
        const lic = e.previousLicense !== e.license ? `${esc(e.previousLicense)} → ${esc(e.license)}` : esc(e.license);
        lines.push(`| ${esc(e.name)} | ${arrow} ${esc(e.from)} → ${esc(e.to)} | ${lic} | ${flagCell(e)} |`);
      }
      lines.push("");
    }
    if (diff.removed.length) {
      lines.push("| Removed | Version | License |", "| --- | --- | --- |");
      for (const e of diff.removed) lines.push(`| ${esc(e.name)} | ${esc(e.version)} | ${esc(e.license)} |`);
      lines.push("");
    }
  }
  lines.push("<sub>Generated from SPDX SBOMs of the base and head commits. Licenses are checked against `scripts/license-allowlist.json`; vulnerabilities come from [OSV](https://osv.dev).</sub>");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readSbom(path) {
  if (!path || !fs.existsSync(path)) return new Map();
  return parseSbom(JSON.parse(fs.readFileSync(path, "utf8")));
}

export async function run(argv, env = process.env) {
  let out = "sbom-diff-comment.md";
  let failOnFlagged = false;
  const pairs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--fail-on-flagged") failOnFlagged = true;
    else if (argv[i].includes("=")) pairs.push(argv[i]);
  }
  const allowedLicenses = JSON.parse(fs.readFileSync(new URL("./license-allowlist.json", import.meta.url), "utf8"));
  const components = [];
  for (const pair of pairs) {
    const [name, files] = pair.split("=");
    const [basePath, headPath] = files.split(":");
    const diff = diffSboms(readSbom(basePath), readSbom(headPath));
    const vulnerabilities =
      env.SBOM_DIFF_SKIP_VULN === "true"
        ? new Map()
        : await lookupVulnerabilities([...diff.added, ...diff.changed.map((c) => ({ purl: c.purl }))]);
    components.push({ name, diff: flagDiff(diff, { allowedLicenses, vulnerabilities }) });
  }
  const markdown = renderComment(components);
  fs.writeFileSync(out, markdown);
  const flagged = components.reduce((n, c) => n + countFlagged(c.diff), 0);
  const changed = components.some((c) => hasChanges(c.diff));
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `changed=${changed}\nflagged=${flagged}\n`);
  console.log(markdown);
  return { changed, flagged, failOnFlagged };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(process.argv.slice(2)).then(({ flagged, failOnFlagged }) => {
    if (failOnFlagged && flagged > 0) process.exit(1);
  });
}
