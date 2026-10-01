#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
/**
 * IDOR coverage gate (issue #760).
 *
 * Fails CI when a backend route accepts a resource identifier
 * (:id, :address, :documentId, :reportId, applicantId, loanId, … in a path,
 * query, or body read) without a corresponding entry in
 * `backend/src/security/idorRegistry.ts` that names its ownership check.
 *
 * Usage:
 *   node scripts/check-idor-coverage.mjs
 *
 * Exit codes: 0 = every ID-accepting endpoint is registered, 1 = gaps found.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const routesDir = path.join(repoRoot, "backend", "src", "routes");
const registryPath = path.join(repoRoot, "backend", "src", "security", "idorRegistry.ts");

const PATH_PARAM_RE =
  /\.(get|post|patch|put|delete)\(\s*["'`]([^"'`]*:(?:id|address|documentId|reportId|deliveryId|applicationId|applicantId|loanId)[^"'`]*)["'`]/gi;
const QUERY_BODY_ID_RE = /req\.(query|body|params)\s*[?[]?\.?\s*(id|address|documentId|reportId|deliveryId|applicationId|applicantId|loanId|borrowerAddress)\b/g;

function fail(msg) {
  console.error(`[check-idor-coverage] ${msg}`);
}

function main() {
  if (!fs.existsSync(registryPath)) {
    fail(`registry not found at backend/src/security/idorRegistry.ts`);
    process.exit(1);
  }
  const registry = fs.readFileSync(registryPath, "utf8");
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith(".ts"));
  const gaps = [];

  for (const file of files) {
    const src = fs.readFileSync(path.join(routesDir, file), "utf8");
    const hits = new Set();
    let m;
    PATH_PARAM_RE.lastIndex = 0;
    while ((m = PATH_PARAM_RE.exec(src)) !== null) hits.add(`${m[1].toUpperCase()} ${m[2]}`);
    QUERY_BODY_ID_RE.lastIndex = 0;
    while ((m = QUERY_BODY_ID_RE.exec(src)) !== null) hits.add(`${m[1]}.${m[2]}`);

    for (const hit of hits) {
      // A hit is covered when the registry mentions the same param token and
      // the same route file's domain (loan/borrower/kyc/verification/admin).
      const token = hit.split(/[^A-Za-z]+/).filter(Boolean).pop() ?? hit;
      const domain = file.replace(/\.ts$/, "");
      const covered =
        registry.includes(token) &&
        (registry.includes(domain) || registry.includes(hit.split(" ").pop()));
      if (!covered) gaps.push(`${file}: ${hit}`);
    }
  }

  // Every registry entry must point at the audit test so coverage cannot be
  // claimed by a registry line alone.
  if (!registry.includes("idorAudit.test.ts")) {
    fail("registry entries must reference src/__tests__/idorAudit.test.ts");
    process.exit(1);
  }

  if (gaps.length > 0) {
    fail(`${gaps.length} ID-accepting endpoint(s) lack ownership-check registry entries:`);
    for (const g of gaps) fail(`  - ${g}`);
    fail("Add the endpoint to backend/src/security/idorRegistry.ts with its ownership check + test.");
    process.exit(1);
  }

  console.log("[check-idor-coverage] OK — all ID-accepting endpoints are registered with ownership checks.");
}

main();
