#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Backend module import-cycle gate (issue #1037).
 *
 * Circular imports between backend modules can creep in unnoticed and cause
 * subtle initialization-order bugs. This script builds the import graph of
 * `backend/src` and reports every cycle (strongly connected component of size
 * > 1, or a module importing itself).
 *
 * Only *runtime* edges count: `import type` / all-`type` named imports and
 * `export type` re-exports are erased by the compiler, so they cannot affect
 * initialization order and are ignored.
 *
 * Cycles that already exist are recorded in `scripts/module-cycles-baseline.json`
 * so the gate can land without failing on pre-existing problems. Only a cycle
 * that is *not* in the baseline fails the check, which is what makes a newly
 * introduced cycle visible in CI.
 *
 * Usage:
 *   npx tsx scripts/check-module-cycles.ts                 # exit 1 on a new cycle
 *   npx tsx scripts/check-module-cycles.ts --json          # machine-readable report
 *   npx tsx scripts/check-module-cycles.ts --update-baseline  # record current cycles
 *
 * Exit codes: 0 = no new cycles, 1 = at least one new cycle, 2 = usage error.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(BACKEND_ROOT, "..");
const SRC_DIR = path.join(BACKEND_ROOT, "src");
const BASELINE_PATH = path.join(SCRIPT_DIR, "module-cycles-baseline.json");

/** Directories that are not part of the shipped backend module graph. */
const SKIP_DIRS = new Set(["__tests__", "test-utils", "node_modules", "dist"]);

interface BaselineEntry {
  modules: string[];
  note?: string;
}

interface Baseline {
  $comment?: string;
  cycles: BaselineEntry[];
}

interface CycleReport {
  ok: boolean;
  modules: number;
  cycles: string[][];
  known: string[][];
  newCycles: string[][];
  staleBaseline: string[][];
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Removes comments without touching string/template contents, so a URL like
 * `"https://…"` is not mistaken for a line comment.
 */
function stripComments(code: string): string {
  let out = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";

  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    const next = code[i + 1];

    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        i++;
      } else if (char === "/" && next === "*") {
        state = "block";
        i++;
      } else {
        if (char === "'") state = "single";
        else if (char === '"') state = "double";
        else if (char === "`") state = "template";
        out += char;
      }
      continue;
    }

    if (state === "line") {
      if (char === "\n") {
        state = "code";
        out += char;
      }
      continue;
    }

    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        i++;
      }
      continue;
    }

    // Inside a string or template literal: keep characters, honour escapes.
    out += char;
    if (char === "\\") {
      out += next ?? "";
      i++;
      continue;
    }
    if ((state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")) {
      state = "code";
    }
  }

  return out;
}

/** True when an import/export clause only references types. */
function isTypeOnlyClause(clause: string): boolean {
  const trimmed = clause.trim();
  if (/^type\b/.test(trimmed)) return true;

  const named = /^\{(.*)\}$/s.exec(trimmed);
  if (!named) return false;

  const specifiers = named[1]
    .split(",")
    .map((specifier) => specifier.trim())
    .filter(Boolean);

  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/.test(specifier));
}

/** Resolves a relative specifier to an existing `.ts` file, or null. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;

  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates: string[] = [];

  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`);
  else if (base.endsWith(".mjs")) candidates.push(`${base.slice(0, -4)}.ts`);
  candidates.push(`${base}.ts`, path.join(base, "index.ts"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every runtime relative import/require inside one source file. */
function collectRuntimeImports(file: string): Set<string> {
  const code = stripComments(fs.readFileSync(file, "utf-8"));
  const dependencies = new Set<string>();

  const fromPatterns = [
    /\bimport\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g,
    /\bexport\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g,
  ];

  for (const pattern of fromPatterns) {
    for (const match of code.matchAll(pattern)) {
      if (isTypeOnlyClause(match[1])) continue;
      const resolved = resolveSpecifier(file, match[2]);
      if (resolved) dependencies.add(resolved);
    }
  }

  const plainPatterns = [
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of plainPatterns) {
    for (const match of code.matchAll(pattern)) {
      const resolved = resolveSpecifier(file, match[1]);
      if (resolved) dependencies.add(resolved);
    }
  }

  return dependencies;
}

/** Tarjan's algorithm; returns every cycle as a sorted list of module ids. */
function findCycles(graph: Map<string, string[]>): string[][] {
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex++;
    stack.push(node);
    onStack.add(node);

    for (const neighbour of graph.get(node) ?? []) {
      if (!indices.has(neighbour)) {
        visit(neighbour);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(neighbour)!));
      } else if (onStack.has(neighbour)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, indices.get(neighbour)!));
      }
    }

    if (lowlink.get(node) !== indices.get(node)) return;

    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);

    component.sort();
    if (component.length > 1 || (graph.get(component[0]) ?? []).includes(component[0])) {
      cycles.push(component);
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }

  return cycles;
}

function signature(modules: string[]): string {
  return [...modules].sort().join("\u0000");
}

function readBaseline(): Baseline {
  if (!fs.existsSync(BASELINE_PATH)) return { cycles: [] };
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
  return { $comment: parsed.$comment, cycles: Array.isArray(parsed.cycles) ? parsed.cycles : [] };
}

function writeBaseline(cycles: string[][], previous: Baseline): void {
  const notes = new Map(previous.cycles.map((entry) => [signature(entry.modules), entry.note]));
  const payload: Baseline = {
    $comment:
      "Circular imports that existed when the module-cycle check (#1037) was added. " +
      "Each entry should be removed once the cycle is broken so it can never return " +
      "unnoticed. Regenerate with: npx tsx scripts/check-module-cycles.ts --update-baseline",
    cycles: cycles.map((modules) => {
      const note = notes.get(signature(modules));
      return note ? { modules, note } : { modules };
    }),
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const updateBaseline = argv.includes("--update-baseline");

  if (!fs.existsSync(SRC_DIR)) {
    process.stderr.write(`[module-cycles] source directory not found: ${SRC_DIR}\n`);
    process.exit(2);
  }

  const files = listSourceFiles(SRC_DIR);
  const id = (absolute: string): string => path.relative(SRC_DIR, absolute).split(path.sep).join("/");

  const graph = new Map<string, string[]>();
  for (const file of files) {
    graph.set(
      id(file),
      [...collectRuntimeImports(file)].map(id).sort()
    );
  }

  const cycles = findCycles(graph).sort((a, b) => signature(a).localeCompare(signature(b)));
  const baseline = readBaseline();
  const knownSignatures = new Set(baseline.cycles.map((entry) => signature(entry.modules)));

  const known = cycles.filter((cycle) => knownSignatures.has(signature(cycle)));
  const newCycles = cycles.filter((cycle) => !knownSignatures.has(signature(cycle)));
  const currentSignatures = new Set(cycles.map(signature));
  const staleBaseline = baseline.cycles
    .filter((entry) => !currentSignatures.has(signature(entry.modules)))
    .map((entry) => [...entry.modules].sort());

  if (updateBaseline) {
    writeBaseline(cycles, baseline);
    process.stdout.write(
      `[module-cycles] baseline updated — ${cycles.length} cycle(s) recorded in ${path.relative(REPO_ROOT, BASELINE_PATH)}.\n`
    );
    process.exit(0);
  }

  const report: CycleReport = {
    ok: newCycles.length === 0,
    modules: graph.size,
    cycles,
    known,
    newCycles,
    staleBaseline,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }

  if (staleBaseline.length > 0) {
    process.stdout.write(
      `[module-cycles] ${staleBaseline.length} baseline entr(ies) no longer cycle — remove them from ${path.relative(REPO_ROOT, BASELINE_PATH)}.\n`
    );
  }

  if (newCycles.length > 0) {
    process.stderr.write(`[module-cycles] ${newCycles.length} new import cycle(s):\n`);
    for (const cycle of newCycles) {
      process.stderr.write(`  - ${cycle.join(" -> ")}\n`);
      const annotation = `${path.relative(REPO_ROOT, path.join(SRC_DIR, cycle[0])).split(path.sep).join("/")}`;
      process.stderr.write(
        `::error file=${annotation},line=1::import cycle introduced: ${cycle.join(" -> ")}\n`
      );
    }
    process.stderr.write(
      "[module-cycles] see docs/MODULE_DEPENDENCY_CYCLES.md for how to break a cycle.\n"
    );
    process.exit(1);
  }

  process.stdout.write(
    `[module-cycles] OK — ${graph.size} module(s), ${known.length} known cycle(s), 0 new.\n`
  );
  process.exit(0);
}

main();
