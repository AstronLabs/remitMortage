#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
/**
 * Open-redirect coverage gate (issue #759).
 *
 * Fails CI when a redirect-accepting path is added without a corresponding
 * validation test:
 *  - backend: any `res.redirect(<request-supplied value>)` that does not go
 *    through `resolveSafeRedirect`/`getSafeRedirectTarget`, or any new
 *    `redirect|returnTo|return_to|next|callbackUrl|redirectUrl` request read
 *    outside `security/redirectValidation.ts` + the audit test.
 *  - frontend: any `NextResponse.redirect(...)` / `router.push(...)` fed by a
 *    `redirect` search param without `resolveSafeRedirect`.
 *
 * Usage:
 *   node scripts/check-redirect-coverage.mjs
 *
 * Exit codes: 0 = all redirect paths validated + tested, 1 = gaps found.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".next", "dist", "coverage", ".turbo"].includes(entry.name)) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(p);
  }
  return out;
}

function fail(msg) {
  console.error(`[check-redirect-coverage] ${msg}`);
}

function main() {
  const gaps = [];
  const backendFiles = walk(path.join(repoRoot, "backend", "src"));
  const frontendFiles = walk(path.join(repoRoot, "frontend", "src"));

  // 1. Backend: raw request value flowing straight into res.redirect.
  for (const file of backendFiles) {
    if (file.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(file, "utf8");
    const m = src.match(/res\.redirect\s*\(\s*([^)]*req\.[^)]*)\)/);
    if (m && !/resolveSafeRedirect|getSafeRedirectTarget/.test(src)) {
      gaps.push(`${path.relative(repoRoot, file)}: raw res.redirect of request value`);
    }
    // New request-supplied redirect params must live behind the validator.
    const readsRedirectParam =
      /req\.(query|body)\s*[?[]?\.?\s*(redirect|returnTo|return_to|next|callbackUrl|redirectUrl)\b/.test(src);
    const isValidatorOrTest =
      file.includes("security/redirectValidation.ts") ||
      file.includes("security/redirectRegistry.ts") ||
      file.includes("__tests__/openRedirectAudit.test.ts");
    if (readsRedirectParam && !isValidatorOrTest) {
      gaps.push(
        `${path.relative(repoRoot, file)}: reads a redirect param without getSafeRedirectTarget — register it in backend/src/security/redirectRegistry.ts`
      );
    }
  }

  // 2. Frontend: redirect search param consumed without the guard.
  for (const file of frontendFiles) {
    if (file.includes("__tests__")) continue;
    const src = fs.readFileSync(file, "utf8");
    const consumesRedirectParam =
      /get\(["'](redirect|returnTo|return_to|next|callbackUrl|redirectUrl)["']\)/.test(src) ||
      /searchParams\.(redirect|returnTo|callbackUrl)\b/.test(src);
    if (file.endsWith("src/middleware.ts")) {
      if (!src.includes("resolveSafeRedirect")) {
        gaps.push(`${path.relative(repoRoot, file)}: middleware redirects without resolveSafeRedirect`);
      }
      continue;
    }
    if (consumesRedirectParam && !src.includes("resolveSafeRedirect")) {
      gaps.push(
        `${path.relative(repoRoot, file)}: consumes a redirect target without resolveSafeRedirect — use frontend/src/lib/safeRedirect.ts`
      );
    }
  }

  // 3. Registry + audit test must exist.
  const registry = path.join(repoRoot, "backend", "src", "security", "redirectRegistry.ts");
  const audit = path.join(repoRoot, "backend", "src", "__tests__", "openRedirectAudit.test.ts");
  if (!fs.existsSync(registry) || !fs.existsSync(audit)) {
    fail("redirectRegistry.ts and openRedirectAudit.test.ts must exist");
    process.exit(1);
  }

  if (gaps.length > 0) {
    fail(`${gaps.length} redirect-accepting path(s) lack validation tests:`);
    for (const g of gaps) fail(`  - ${g}`);
    fail("Validate via resolveSafeRedirect/getSafeRedirectTarget and register the path.");
    process.exit(1);
  }

  console.log("[check-redirect-coverage] OK — all redirect-accepting paths are validated and tested.");
}

main();
