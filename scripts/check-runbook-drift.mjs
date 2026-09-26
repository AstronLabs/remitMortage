#!/usr/bin/env node
// Runbook Drift Detector
//
// Runbooks under docs/ reference specific Terraform-managed infrastructure
// (resource names, ARNs, thresholds). Those references silently go stale as
// the infrastructure evolves, leaving on-call engineers following incorrect
// instructions during an incident. This script extracts machine-checkable
// claims from fenced ```runbook-ref``` blocks and compares them against the
// live Terraform outputs/state they describe.
//
// See docs/RUNBOOK_DRIFT_DETECTION.md for the annotation convention.
//
// Usage:
//   node scripts/check-runbook-drift.mjs [docsDir]
//
// Exit codes (mirrors backend/scripts/detect-prisma-drift.sh):
//   0 = no drift, no parse errors
//   1 = execution error (couldn't read Terraform state/outputs, malformed ref)
//   2 = drift detected (a ref no longer matches live infrastructure)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_DOCS_DIR = path.join(REPO_ROOT, "docs");
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next"]);
const DEFAULT_ROOT = "devops";
const DEFAULT_ENVIRONMENT = "production";
const REQUIRED_ONE_OF = ["resource", "output"];

const REF_BLOCK_PATTERN = /```runbook-ref\r?\n([\s\S]*?)```/g;

// ── Parsing ──────────────────────────────────────────────────────────────

/**
 * Finds every `.md` file under `dir`, skipping vendor/build directories.
 */
export function findMarkdownFiles(dir) {
  const matches = [];
  if (!fs.existsSync(dir)) return matches;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) matches.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      matches.push(fullPath);
    }
  }

  return matches;
}

/** Parses a `key: value` block body into a plain object. Blank lines and `#` comments are ignored. */
function parseKeyValueBlock(body) {
  const fields = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sepIndex = line.indexOf(":");
    if (sepIndex === -1) {
      throw new Error(`Malformed line (expected "key: value"): "${line}"`);
    }
    const key = line.slice(0, sepIndex).trim();
    const value = line.slice(sepIndex + 1).trim();
    fields[key] = value;
  }
  return fields;
}

/**
 * Extracts every `runbook-ref` block from a markdown file's contents.
 *
 * Returns `{ refs, errors }` rather than throwing on a single bad block, so
 * one author's typo doesn't hide every other file's findings in the same run.
 */
export function extractRunbookRefs(markdown, filePath) {
  const refs = [];
  const errors = [];

  let match;
  REF_BLOCK_PATTERN.lastIndex = 0;
  while ((match = REF_BLOCK_PATTERN.exec(markdown)) !== null) {
    const lineNumber = markdown.slice(0, match.index).split("\n").length;

    try {
      const fields = parseKeyValueBlock(match[1]);

      if (!REQUIRED_ONE_OF.some((key) => fields[key])) {
        throw new Error(`Block must set at least one of: ${REQUIRED_ONE_OF.join(", ")}`);
      }
      if (fields.output && !fields.expect) {
        throw new Error(`Block references output "${fields.output}" but has no "expect" value to check it against`);
      }

      refs.push({
        file: filePath,
        line: lineNumber,
        resource: fields.resource ?? null,
        output: fields.output ?? null,
        expect: fields.expect ?? null,
        root: fields.root || DEFAULT_ROOT,
        environment: fields.environment || DEFAULT_ENVIRONMENT,
        note: fields.note ?? null,
      });
    } catch (err) {
      errors.push({ file: filePath, line: lineNumber, message: err.message });
    }
  }

  return { refs, errors };
}

/** Runs {@link extractRunbookRefs} over every markdown file found under `docsDir`. */
export function collectRunbookRefs(docsDir) {
  const refs = [];
  const errors = [];

  for (const file of findMarkdownFiles(docsDir)) {
    const markdown = fs.readFileSync(file, "utf8");
    const relPath = path.relative(REPO_ROOT, file);
    const result = extractRunbookRefs(markdown, relPath);
    refs.push(...result.refs);
    errors.push(...result.errors);
  }

  return { refs, errors };
}

/** Groups refs by the (root, environment) pair whose Terraform state they need. */
export function groupRefsByTarget(refs) {
  const groups = new Map();
  for (const ref of refs) {
    const key = `${ref.root}::${ref.environment}`;
    if (!groups.has(key)) groups.set(key, { root: ref.root, environment: ref.environment, refs: [] });
    groups.get(key).refs.push(ref);
  }
  return [...groups.values()];
}

// ── Comparison ───────────────────────────────────────────────────────────

/**
 * Compares one ref against the Terraform data for its target.
 *
 * `terraformData` is `{ outputs: Record<string, { value: unknown }>, resourceAddresses: string[] }`
 * — deliberately plain data (not a live Terraform process) so this stays a
 * pure, fast-to-test function. The CLI entrypoint is what wires it to real
 * `terraform output -json` / `terraform state list` calls.
 */
export function compareRefToTerraform(ref, terraformData) {
  const { outputs, resourceAddresses } = terraformData;

  if (ref.resource) {
    if (!resourceAddresses.includes(ref.resource)) {
      return {
        ref,
        status: "missing_resource",
        message: `Resource "${ref.resource}" no longer exists in Terraform state for ${ref.root} (${ref.environment}) — it may have been renamed or removed.`,
      };
    }
  }

  if (ref.output) {
    if (!Object.prototype.hasOwnProperty.call(outputs, ref.output)) {
      return {
        ref,
        status: "missing_output",
        message: `Output "${ref.output}" no longer exists for ${ref.root} (${ref.environment}) — the runbook's referenced value can no longer be verified.`,
      };
    }

    const liveValue = String(outputs[ref.output].value).trim();
    const expected = String(ref.expect).trim();
    if (liveValue !== expected) {
      return {
        ref,
        status: "value_changed",
        message: `Output "${ref.output}" is now "${liveValue}" but the runbook says "${expected}".`,
      };
    }
  }

  return { ref, status: "ok", message: null };
}

/**
 * Runs {@link compareRefToTerraform} for every ref against its matching
 * Terraform target and returns only the non-"ok" findings.
 *
 * `terraformDataByTarget` maps `"${root}::${environment}"` to the same shape
 * `compareRefToTerraform` expects. A ref whose target is missing from the map
 * is reported as its own finding rather than silently skipped.
 */
export function runDriftCheck(refs, terraformDataByTarget) {
  const findings = [];

  for (const ref of refs) {
    const key = `${ref.root}::${ref.environment}`;
    const data = terraformDataByTarget[key];

    if (!data) {
      findings.push({
        ref,
        status: "target_unavailable",
        message: `Could not read Terraform state/outputs for ${ref.root} (${ref.environment}).`,
      });
      continue;
    }

    const result = compareRefToTerraform(ref, data);
    if (result.status !== "ok") findings.push(result);
  }

  return findings;
}

// ── Live Terraform data (CLI only — not exercised by unit tests) ─────────

const BACKEND_KEY_BY_ROOT = {
  devops: (environment) => `remitmortgage/${environment}/terraform.tfstate`,
  "devops/terraform": () => "remitmortgage/multi-region/terraform.tfstate",
};

function loadTerraformDataForTarget(root, environment) {
  const cwd = path.join(REPO_ROOT, root);
  const backendKey = (BACKEND_KEY_BY_ROOT[root] ?? BACKEND_KEY_BY_ROOT.devops)(environment);

  execFileSync("terraform", ["init", "-input=false", `-backend-config=key=${backendKey}`], {
    cwd,
    stdio: "pipe",
  });

  const outputsJson = execFileSync("terraform", ["output", "-json"], { cwd, encoding: "utf8" });
  const stateListRaw = execFileSync("terraform", ["state", "list"], { cwd, encoding: "utf8" });

  return {
    outputs: JSON.parse(outputsJson),
    resourceAddresses: stateListRaw.split("\n").map((line) => line.trim()).filter(Boolean),
  };
}

function formatReport(findings, parseErrors) {
  const lines = [];

  if (parseErrors.length > 0) {
    lines.push(`${parseErrors.length} malformed runbook-ref block(s):`);
    for (const err of parseErrors) {
      lines.push(`  - ${err.file}:${err.line} — ${err.message}`);
    }
    lines.push("");
  }

  if (findings.length > 0) {
    lines.push(`${findings.length} drifted runbook reference(s):`);
    for (const finding of findings) {
      lines.push(`  - ${finding.ref.file}:${finding.ref.line} [${finding.status}] ${finding.message}`);
    }
  }

  if (parseErrors.length === 0 && findings.length === 0) {
    lines.push("No runbook drift detected — all runbook-ref blocks match live infrastructure.");
  }

  return lines.join("\n");
}

function main() {
  const docsDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_DOCS_DIR;
  const { refs, errors: parseErrors } = collectRunbookRefs(docsDir);

  if (refs.length === 0 && parseErrors.length === 0) {
    console.log(`No runbook-ref blocks found under ${path.relative(REPO_ROOT, docsDir)}.`);
    process.exit(0);
  }

  const targets = groupRefsByTarget(refs);
  const terraformDataByTarget = {};
  let executionError = false;

  for (const { root, environment } of targets) {
    const key = `${root}::${environment}`;
    try {
      terraformDataByTarget[key] = loadTerraformDataForTarget(root, environment);
    } catch (err) {
      executionError = true;
      console.error(`Failed to read Terraform state for ${root} (${environment}): ${err.message}`);
    }
  }

  const findings = runDriftCheck(refs, terraformDataByTarget);
  console.log(formatReport(findings, parseErrors));

  if (executionError && findings.length === 0 && parseErrors.length === 0) {
    process.exit(1);
  }
  if (parseErrors.length > 0 && findings.length === 0) {
    process.exit(1);
  }
  if (findings.length > 0) {
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
