#!/usr/bin/env node
/**
 * ADR format and index-linkage checker.
 *
 * Every file in docs/adr/ matching `NNNN-kebab-title.md` (the ADR naming
 * convention from docs/adr/template.md) must:
 *   1. Start with a level-1 heading `# ADR-NNNN: <title>` whose number
 *      matches the filename's NNNN prefix.
 *   2. Contain, in order, the five required level-2 headings: Status,
 *      Context, Decision, Consequences, Alternatives Considered — each
 *      with non-empty content before the next heading (or EOF).
 *   3. Be linked from docs/adr/README.md (a markdown link whose target is
 *      exactly that file's name).
 *
 * `docs/adr/template.md` and `docs/adr/README.md` are not ADRs and are
 * skipped by the `NNNN-*.md` filename pattern itself.
 *
 * Usage:
 *   node scripts/check-adr-format.mjs
 *
 * Exit codes: 0 = all ADRs valid, 1 = one or more violations found.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ADR_DIR = "docs/adr";
const README_PATH = join(ADR_DIR, "README.md");

const REQUIRED_HEADINGS = ["Status", "Context", "Decision", "Consequences", "Alternatives Considered"];

const FILENAME_PATTERN = /^(\d{4})-[a-z0-9-]+\.md$/;

/**
 * Splits a markdown file into { level, title, body } sections by heading,
 * in document order. `body` is the raw text between this heading and the
 * next heading of level <= this one's (approximated here as "the next
 * heading at all", which is sufficient for the flat H1/H2 structure ADRs
 * use).
 */
export function splitSections(markdown) {
  const lines = markdown.split(/\r?\n/);
  const sections = [];
  let current = null;

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      if (current) sections.push(current);
      current = { level: match[1].length, title: match[2].trim(), body: [] };
    } else if (current) {
      current.body.push(line);
    }
  }
  if (current) sections.push(current);

  return sections.map((s) => ({ ...s, body: s.body.join("\n").trim() }));
}

/** Validates one ADR file's content. Returns a list of problem strings (empty = valid). */
export function validateAdrContent(filename, content) {
  const problems = [];
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) return [`filename does not match NNNN-kebab-title.md`];
  const fileNumber = match[1];

  const sections = splitSections(content);
  const h1 = sections.find((s) => s.level === 1);
  if (!h1) {
    problems.push("missing a level-1 `# ADR-NNNN: <title>` heading");
  } else {
    const titleMatch = /^ADR-(\d{4}):\s*(.+)$/.exec(h1.title);
    if (!titleMatch) {
      problems.push(`level-1 heading "${h1.title}" does not match "ADR-NNNN: <title>"`);
    } else if (titleMatch[1] !== fileNumber) {
      problems.push(`heading number ADR-${titleMatch[1]} does not match filename number ${fileNumber}`);
    } else if (!titleMatch[2].trim()) {
      problems.push("ADR title is empty");
    }
  }

  const h2s = sections.filter((s) => s.level === 2);
  const h2Titles = h2s.map((s) => s.title);
  let lastIndex = -1;
  for (const required of REQUIRED_HEADINGS) {
    const idx = h2Titles.indexOf(required);
    if (idx === -1) {
      problems.push(`missing required section "## ${required}"`);
      continue;
    }
    if (idx < lastIndex) {
      problems.push(`section "## ${required}" is out of order (expected after the previous required section)`);
    }
    lastIndex = Math.max(lastIndex, idx);
    if (!h2s[idx].body) {
      problems.push(`section "## ${required}" has no content`);
    }
  }

  return problems;
}

/** Checks that `filename` is linked (as a markdown link target) from the index README. */
export function isLinkedFromIndex(filename, readmeContent) {
  const linkPattern = new RegExp(`\\]\\(${filename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`);
  return linkPattern.test(readmeContent);
}

function main() {
  let entries;
  try {
    entries = readdirSync(ADR_DIR);
  } catch (err) {
    console.error(`❌ Could not read ${ADR_DIR}: ${err.message}`);
    process.exit(1);
  }

  let readme = "";
  try {
    readme = readFileSync(README_PATH, "utf8");
  } catch {
    console.error(`❌ ${README_PATH} is missing — the ADR index must exist.`);
    process.exit(1);
  }

  const adrFiles = entries.filter((f) => FILENAME_PATTERN.test(f)).sort();
  if (adrFiles.length === 0) {
    console.error(`❌ No ADR files found in ${ADR_DIR} matching NNNN-kebab-title.md.`);
    process.exit(1);
  }

  let failed = false;
  for (const filename of adrFiles) {
    const content = readFileSync(join(ADR_DIR, filename), "utf8");
    const problems = validateAdrContent(filename, content);
    if (!isLinkedFromIndex(filename, readme)) {
      problems.push(`not linked from ${README_PATH}`);
    }
    if (problems.length > 0) {
      failed = true;
      console.error(`❌ ${join(ADR_DIR, filename)}:`);
      for (const p of problems) console.error(`   - ${p}`);
    } else {
      console.log(`✅ ${join(ADR_DIR, filename)}`);
    }
  }

  if (failed) {
    console.error(
      "\n❌ One or more ADRs failed validation. See docs/adr/template.md and docs/adr/README.md."
    );
    process.exit(1);
  }
  console.log(`\n✅ All ${adrFiles.length} ADR(s) follow the template and are linked from the index.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
