#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// check-workflow-permissions.mjs
//
// Audits GITHUB_TOKEN permissions across .github/workflows/*.yml for
// least-privilege violations:
//
//   ERROR   A workflow declares no `permissions:` at all (neither at the
//           workflow level nor on every job), so its jobs silently inherit
//           whatever the repository/org default token permissions are —
//           which may be broad read/write and can change without this
//           repo noticing.
//   ERROR   `permissions: write-all` (or any `-all` shorthand) anywhere.
//   WARNING A write scope is granted (workflow- or job-level) with no
//           evidence in that job's steps that it is actually used. This is
//           a heuristic based on known actions/commands per scope — false
//           positives are possible for novel actions, so it never fails
//           the build on its own.
//
// Usage
//   node scripts/check-workflow-permissions.mjs                 audit every workflow
//   node scripts/check-workflow-permissions.mjs <file> [file..]  audit only these files
//   node scripts/check-workflow-permissions.mjs --out report.md  also write the report
//
// Exit codes
//   0 — no ERROR-level findings among the scanned files (warnings are OK)
//   1 — at least one ERROR-level finding
//
// See docs/WORKFLOW_PERMISSIONS_AUDIT.md for the full policy.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const WORKFLOWS_DIR = ".github/workflows";

// Evidence a write scope's grant is actually exercised by the job/workflow
// it is attached to. Matched against the raw text with a case-insensitive
// search. Read-only scopes are never flagged — granting read access is low
// risk and near-universally needed for checkout/API calls.
const WRITE_SCOPE_EVIDENCE = {
  contents:
    /git\s+(push|commit|tag)|create-pull-request|action-gh-release|create-release|git-auto-commit|createOrUpdateFileContents|createRelease|createTag|actions\/upload-release-asset/i,
  "pull-requests":
    /create-pull-request|pulls\.(create|update|merge|dismissReview)|gh pr (create|comment|merge|edit)|createComment.*pull|dependabot\/fetch-metadata/i,
  issues:
    /issues\.(create|update|createComment|addLabels)|gh issue (create|comment|edit)/i,
  "id-token":
    /configure-aws-credentials|role-to-assume|azure\/login|google-github-actions\/auth|cosign-installer|hashicorp\/vault-action/i,
  packages:
    /docker\/login-action|ghcr\.io|docker(\s+buildx)?\s+push|npm publish|actions\/upload-release-asset/i,
  checks: /checks\.(create|update)|create-check/i,
  deployments: /deployments\.(create|update)|bobheadxi\/deployments/i,
  "security-events": /upload-sarif|codeql-action\/(upload-sarif|analyze)/i,
  statuses: /statuses\.create|createCommitStatus/i,
  discussions: /discussions\.create/i,
  pages: /actions\/deploy-pages|configure-pages/i,
  actions: /actions\.(cancelWorkflowRun|reRunWorkflow|reRunWorkflowFailedJobs)/i,
};

function isStructural(line) {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

function indentOf(line) {
  return line.match(/^(\s*)/)[1].length;
}

// Returns the exclusive end index of the indented block that starts right
// after `startIdx` (a "key:" line at `indent`). Blank/comment lines never
// end a block early.
function blockEnd(lines, startIdx, indent) {
  let i = startIdx + 1;
  let end = startIdx + 1;
  while (i < lines.length) {
    if (isStructural(lines[i])) {
      if (indentOf(lines[i]) <= indent) break;
      end = i + 1;
    } else {
      end = i + 1;
    }
    i++;
  }
  return end;
}

// Parses a `permissions:` key found at `lines[idx]` (either inline scalar
// like `permissions: write-all` / `permissions: {}`, or a block mapping of
// `scope: access` on following lines). Returns { scopes: Map, writeAll }.
function parsePermissions(lines, idx, indent) {
  const inline = lines[idx].slice(lines[idx].indexOf(":") + 1).trim();
  const scopes = new Map();
  let writeAll = false;

  if (inline && inline !== "{}") {
    if (/^["']?(write|read)-all["']?$/.test(inline)) {
      if (inline.startsWith("write")) writeAll = true;
      // read-all is broad but read-only; not flagged as an error.
    }
    return { scopes, writeAll, declared: true };
  }

  const end = blockEnd(lines, idx, indent);
  for (let i = idx + 1; i < end; i++) {
    if (!isStructural(lines[i])) continue;
    const m = lines[i].trim().match(/^([\w-]+)\s*:\s*(\S+)/);
    if (m) scopes.set(m[1], m[2].replace(/["']/g, ""));
  }
  return { scopes, writeAll, declared: true };
}

function findJobs(lines) {
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return [];
  const jobsIndent = indentOf(lines[jobsIdx]);
  const jobs = [];
  let i = jobsIdx + 1;
  while (i < lines.length) {
    if (isStructural(lines[i])) {
      const ind = indentOf(lines[i]);
      if (ind <= jobsIndent) break;
      const m = lines[i].match(/^(\s*)([\w-]+)\s*:\s*$/);
      if (m && ind === jobsIndent + 2) {
        const name = m[2];
        const start = i;
        const end = blockEnd(lines, i, ind);
        jobs.push({ name, start, end, indent: ind });
      }
    }
    i++;
  }
  return jobs;
}

function findKeyInBlock(lines, start, end, indent, key) {
  for (let i = start; i < end; i++) {
    if (!isStructural(lines[i])) continue;
    if (indentOf(lines[i]) !== indent) continue;
    if (new RegExp(`^${key}\\s*:`).test(lines[i].trim())) return i;
  }
  return -1;
}

function auditWorkflow(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const findings = [];

  // Top-level `permissions:` (indent 0), searched before `jobs:` starts.
  const jobsLineIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const topPermIdx = lines.findIndex(
    (l, i) =>
      /^permissions\s*:/.test(l) &&
      (jobsLineIdx === -1 || i < jobsLineIdx)
  );

  let topLevel = { scopes: new Map(), writeAll: false, declared: false };
  if (topPermIdx !== -1) {
    topLevel = parsePermissions(lines, topPermIdx, 0);
  }

  if (topLevel.writeAll) {
    findings.push({
      severity: "ERROR",
      message: "Top-level `permissions: write-all` grants every scope repo-wide.",
    });
  }

  const jobs = findJobs(lines);

  if (!topLevel.declared && jobs.length === 0) {
    findings.push({
      severity: "ERROR",
      message:
        "No `permissions:` block found and no jobs to check — verify this is a valid workflow.",
    });
  }

  let anyJobMissingPermissions = false;

  for (const job of jobs) {
    const jobBodyIndent = job.indent + 2;
    const permIdx = findKeyInBlock(
      lines,
      job.start + 1,
      job.end,
      jobBodyIndent,
      "permissions"
    );
    const jobText = lines.slice(job.start, job.end).join("\n");
    const usesReusableWorkflow = /^\s*uses:\s*\S+\/\.github\/workflows\//m.test(
      jobText
    );

    let effective;
    let source;
    if (permIdx !== -1) {
      effective = parsePermissions(lines, permIdx, jobBodyIndent);
      source = "job";
    } else if (topLevel.declared) {
      effective = topLevel;
      source = "workflow";
    } else {
      effective = { scopes: new Map(), writeAll: false, declared: false };
      source = "none";
    }

    if (effective.writeAll && source === "job") {
      findings.push({
        severity: "ERROR",
        message: `Job "${job.name}" sets \`permissions: write-all\`.`,
      });
    }

    if (source === "none" && !usesReusableWorkflow) {
      anyJobMissingPermissions = true;
    }

    // Heuristic: does each write scope this job effectively has look used?
    if (source !== "none") {
      for (const [scope, access] of effective.scopes) {
        if (access !== "write") continue;
        const evidence = WRITE_SCOPE_EVIDENCE[scope];
        if (evidence && !evidence.test(jobText)) {
          findings.push({
            severity: "WARNING",
            message:
              `Job "${job.name}" is granted \`${scope}: write\` (via ${source}` +
              `${source === "workflow" ? "-level permissions" : ""}) but no step ` +
              `in this job matches known usage for that scope — confirm it's needed.`,
          });
        }
      }
    }
  }

  if (!topLevel.declared && anyJobMissingPermissions) {
    findings.push({
      severity: "ERROR",
      message:
        "No workflow-level `permissions:` block, and at least one job declares none either " +
        "— those jobs inherit the repository/org default token permissions, which may be " +
        "broader than needed. Add an explicit `permissions:` block (e.g. `contents: read`) " +
        "at the workflow level or to every job.",
    });
  }

  return findings;
}

function listWorkflowFiles() {
  return fs
    .readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

function buildReport(results) {
  const lines = [];
  const errorFiles = results.filter((r) => r.findings.some((f) => f.severity === "ERROR"));
  const warnFiles = results.filter(
    (r) =>
      !r.findings.some((f) => f.severity === "ERROR") &&
      r.findings.some((f) => f.severity === "WARNING")
  );
  const cleanCount = results.length - errorFiles.length - warnFiles.length;

  lines.push("# GitHub Actions Workflow Permission Audit");
  lines.push("");
  lines.push(
    `Scanned ${results.length} workflow file(s): ${errorFiles.length} with errors, ` +
      `${warnFiles.length} with warnings only, ${cleanCount} clean.`
  );
  lines.push("");

  for (const { file, findings } of results) {
    if (findings.length === 0) continue;
    lines.push(`## ${file}`);
    for (const f of findings) {
      lines.push(`- **${f.severity}**: ${f.message}`);
    }
    lines.push("");
  }

  if (results.every((r) => r.findings.length === 0)) {
    lines.push("No findings.");
  }

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  let outPath = null;
  const outIdx = args.indexOf("--out");
  if (outIdx !== -1) {
    outPath = args[outIdx + 1];
    args.splice(outIdx, 2);
  }

  const targets = args.length > 0 ? args : listWorkflowFiles();

  const results = targets.map((file) => ({
    file,
    findings: auditWorkflow(file),
  }));

  const report = buildReport(results);
  console.log(report);

  if (outPath) {
    fs.writeFileSync(outPath, report + "\n");
  }

  const errorCount = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "ERROR").length,
    0
  );
  const warningCount = results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "WARNING").length,
    0
  );

  console.log(
    `\n${errorCount} error(s), ${warningCount} warning(s) across ${targets.length} file(s).`
  );

  process.exit(errorCount > 0 ? 1 : 0);
}

main();
