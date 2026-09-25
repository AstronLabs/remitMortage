#!/usr/bin/env node
/**
 * License header enforcement checker and auto-fixer.
 *
 * Scans backend, frontend, and contracts source files for the required MIT
 * license header and optionally inserts it.
 *
 * Usage:
 *   node scripts/check-license-header.mjs           # check mode (CI)
 *   node scripts/check-license-header.mjs --fix     # auto-fix mode
 *
 * Exit codes: 0 = all headers present, 1 = violations found, 2 = usage error.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEADER_LINES = [
  "// Copyright (c) 2026 RemitMortgage Protocol Contributors",
  "// SPDX-License-Identifier: MIT",
];
const HEADER_BLOCK = HEADER_LINES.join("\n");

// Roots and file patterns scanned by the CI job.
const SCAN_CONFIG = [
  { root: "backend/src", extensions: new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]) },
  { root: "frontend/src", extensions: new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]) },
  { root: "contracts", extensions: new Set([".rs"]), subFilter: (p) => p.includes(`${path.sep}src${path.sep}`) || p.startsWith(`src${path.sep}`) },
];

// Default ignore globs (mirrors .gitignore + .prettierignore + eslint globalIgnores).
// Contributors can extend via scripts/license-header-ignore.json (array of glob strings).
const DEFAULT_IGNORE_PATTERNS = [
  "**/node_modules/**",
  "**/.next/**",
  "**/out/**",
  "**/build/**",
  "**/dist/**",
  "**/coverage/**",
  "**/target/**",
  "**/.swc/**",
  "**/.terraform/**",
  "**/storage/kyc-private/**",
  "**/next-env.d.ts",
  "**/*.tsbuildinfo",
  "**/*.wasm",
  "**/*.d.ts",
];

function loadIgnorePatterns(repoRoot) {
  const customPath = path.join(repoRoot, "scripts", "license-header-ignore.json");
  let extra = [];
  if (fs.existsSync(customPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(customPath, "utf8"));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw.ignore) ? raw.ignore : [];
      extra = list.map((s) => String(s).trim()).filter(Boolean);
    } catch {
      // malformed custom ignore -> fall back to defaults only
    }
  }
  return [...DEFAULT_IGNORE_PATTERNS, ...extra];
}

function globToRegExp(glob) {
  // Convert a simple glob pattern to RegExp. Supports **, *, ?, escaping.
  // This is intentionally minimal — enough for the ignore list.
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*\\/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if ("+|()[]{}^$\\.".includes(c)) {
      re += `\\${c}`;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

function isIgnored(relativePosix, ignoreRes) {
  const posix = relativePosix.replace(/\\/g, "/");
  return ignoreRes.some((re) => re.test(posix));
}

function walkFiles(repoRoot, scanRoot, extensions, subFilter, ignoreRes, out) {
  const absRoot = path.join(repoRoot, scanRoot);
  if (!fs.existsSync(absRoot)) return;
  const stack = [absRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, full);
      const relPosix = rel.replace(/\\/g, "/");
      if (isIgnored(relPosix, ignoreRes)) continue;
      // Also skip hidden directories and well-known generated names quickly
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name);
        if (!extensions.has(ext)) continue;
        if (subFilter && !subFilter(rel)) continue;
        out.push(rel);
      }
    }
  }
}

function detectLineEnding(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// Whether the file already carries the required header.
// Tolerates: optional shebang on line 1, optional "use client"/"use server" directive
// on the first code line, then the header must appear within the next few lines.
function hasHeader(text) {
  const lines = text.split(/\r?\n/);
  let idx = 0;
  // Skip leading empty lines (shouldn't exist but be lenient)
  while (idx < lines.length && lines[idx].trim() === "") idx++;

  // Optional shebang (strict: #!/ or #! followed by space; not Rust #![...])
  if (idx < lines.length && /^#!\//.test(lines[idx])) idx++;
  else if (idx < lines.length && /^#!\s/.test(lines[idx])) idx++;

  // Optional "use client" / "use server" directives (possibly with single or double quotes, with semicolon)
  const directiveRe = /^\s*["']use (client|server)["']\s*;?\s*$/;
  while (idx < lines.length && directiveRe.test(lines[idx])) {
    idx++;
    // Skip blank lines between directive and header
    while (idx < lines.length && lines[idx].trim() === "") idx++;
  }

  // Skip any additional blank lines before header
  while (idx < lines.length && lines[idx].trim() === "") idx++;

  if (idx + HEADER_LINES.length > lines.length) return false;
  for (let i = 0; i < HEADER_LINES.length; i++) {
    if (lines[idx + i].trim() !== HEADER_LINES[i]) return false;
  }
  return true;
}

function insertHeader(text) {
  if (hasHeader(text)) return { changed: false, text };

  const eol = detectLineEnding(text);
  const lines = text.split(/\r?\n/);

  // Find insertion point after optional shebang and directives
  let insertAt = 0;
  // Skip leading empty? Keep them? We insert at logical top.
  // Handle shebang as line 0 if present (strict: #!/ or #! space; not Rust #![)
  if (lines.length > 0 && (/^#!/.test(lines[0]) && !lines[0].startsWith("#!["))) {
    if (/^#!\//.test(lines[0]) || /^#!\s/.test(lines[0])) insertAt = 1;
    else insertAt = 0;
  } else {
    insertAt = 0;
  }

  const directiveRe = /^\s*["']use (client|server)["']\s*;?\s*$/;
  // If insertAt is after shebang, check for directive lines
  let cursor = insertAt;
  // Skip blank lines after shebang before checking directives? Keep logic simple: directives must immediately follow shebang
  while (cursor < lines.length && directiveRe.test(lines[cursor])) {
    cursor++;
    // Keep directives together
    // Do not skip blank lines between directives? Directives are contiguous at top
  }
  // If we consumed any directives, insert after them
  if (cursor > insertAt) {
    insertAt = cursor;
  }

  // Avoid duplicating blank line if header already followed by blank line
  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);

  // Trim one leading blank line from `after` if header will add one, to avoid double blank when original file starts with blank?
  // Actually we want exactly one blank line between header and original content unless original content is empty.
  let headerInsertion;
  if (after.length === 0 || (after.length === 1 && after[0] === "")) {
    // Empty file or only newline
    headerInsertion = HEADER_LINES.join(eol) + eol;
  } else {
    // If file starts with blank lines, preserve one? Remove leading blank lines from after that would create double spacing
    // We will produce: [before/directives] + header + "" + after(without leading blanks)
    let afterTrimmed = after;
    // Remove leading blank lines from after (they would become extra spacing)
    let trimCount = 0;
    while (trimCount < afterTrimmed.length && afterTrimmed[trimCount].trim() === "") trimCount++;
    if (trimCount > 0) afterTrimmed = afterTrimmed.slice(trimCount);
    // Rebuild
    const headerWithGap = [...HEADER_LINES, ""];
    const newLines = [...before, ...headerWithGap, ...afterTrimmed];
    return { changed: true, text: newLines.join(eol) };
  }

  // Fallback simple insertion (empty file case)
  const newLines = [...before, ...HEADER_LINES, ...after];
  // Ensure header block separated by blank line if needed: handled above
  return { changed: true, text: newLines.join(eol) };
}

export function checkFiles(repoRoot) {
  const ignorePatterns = loadIgnorePatterns(repoRoot);
  const ignoreRes = ignorePatterns.map(globToRegExp);
  const files = [];
  for (const cfg of SCAN_CONFIG) {
    walkFiles(repoRoot, cfg.root, cfg.extensions, cfg.subFilter ?? null, ignoreRes, files);
  }
  files.sort();
  const missing = [];
  for (const rel of files) {
    const full = path.join(repoRoot, rel);
    let text;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!hasHeader(text)) missing.push(rel);
  }
  return { files, missing, ignorePatterns };
}

export function fixFiles(repoRoot) {
  const { missing } = checkFiles(repoRoot);
  let fixed = 0;
  for (const rel of missing) {
    const full = path.join(repoRoot, rel);
    const text = fs.readFileSync(full, "utf8");
    const { changed, text: next } = insertHeader(text);
    if (changed) {
      fs.writeFileSync(full, next, "utf8");
      fixed++;
    }
  }
  return { missing, fixed };
}

// CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const args = process.argv.slice(2);
  const doFix = args.includes("--fix");
  const help = args.includes("--help") || args.includes("-h");
  if (help) {
    console.log(`Usage: node scripts/check-license-header.mjs [--fix]

Checks that backend/src, frontend/src, and contracts/*/src files carry the required license header:
  ${HEADER_BLOCK.replace(/\n/g, "\n  ")}

Options:
  --fix   Insert missing headers in place (idempotent, preserves other content)
  --help  Show this help
Ignore list: scripts/license-header-ignore.json (array or {ignore: [...]}) plus built-in defaults.
`);
    process.exit(0);
  }
  // Allow optional repo root as last non-flag arg (for testing)
  const repoRootArg = args.find((a) => !a.startsWith("--") && a !== "--fix");
  const repoRoot = repoRootArg ? path.resolve(repoRootArg) : process.cwd();

  if (doFix) {
    const { missing, fixed } = fixFiles(repoRoot);
    if (missing.length === 0) {
      console.log("License header OK: all source files carry the required header.");
    } else {
      console.log(`License header FIX: inserted header into ${fixed}/${missing.length} files:`);
      for (const m of missing) console.log(`  + ${m}`);
    }
    process.exit(0);
  } else {
    const { missing } = checkFiles(repoRoot);
    if (missing.length > 0) {
      console.error("License header check FAILED: the following source files are missing the required header:");
      console.error(`Required header (first lines of file):`);
      for (const l of HEADER_LINES) console.error(`  ${l}`);
      console.error("");
      for (const m of missing) console.error(`  - ${m}`);
      console.error("");
      console.error("Fix locally with: node scripts/check-license-header.mjs --fix");
      console.error("Ignore list: scripts/license-header-ignore.json (documented in scripts/README.md)");
      process.exit(1);
    }
    const total = checkFiles(repoRoot).files.length;
    console.log(`License header OK: ${total} source files checked, all headers present.`);
  }
}
