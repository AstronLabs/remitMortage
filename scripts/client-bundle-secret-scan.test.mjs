// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkPublicPrefix,
  collectEnvSecrets,
  evaluate,
  extractEnvReads,
  extractNextConfigEnvKeys,
  isClientSource,
  isValidStellarSecretSeed,
  loadAllowlist,
  redact,
  renderReport,
  run,
  scanContent,
  sha256,
} from "./client-bundle-secret-scan.mjs";

// ── Planted fake secrets ────────────────────────────────────────────────────
// Assembled at runtime so no secret-shaped literal sits in the repository.

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
/** A checksum-valid (but throwaway) Stellar secret seed. */
function fakeStellarSeed(fill = 7) {
  const payload = Uint8Array.from([18 << 3, ...new Array(32).fill(fill)]);
  const crc = crc16(payload);
  const bytes = [...payload, crc & 0xff, crc >> 8];
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

const FAKES = {
  stellar: fakeStellarSeed(),
  aws: "AKIA" + "QWERTYUIOPASDFGH",
  github: "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
  slack: "xoxb-" + "1234567890-abcdefghijkl",
  stripe: "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----",
  jwt: "eyJhbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  dbUrl: "postgres://app_user:" + "s3cr3tP4ssw0rdX" + "@db.internal:5432/app",
  generic: "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7",
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bundle-scan-"));
}
function write(dir, rel, content) {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const noAllowlist = { values: [], hashes: [], files: [], env: [] };

// ── Rule detection ──────────────────────────────────────────────────────────

test("a planted secret of every known format is detected", () => {
  const cases = {
    "stellar-secret-seed": `var k="${FAKES.stellar}";`,
    "aws-access-key-id": `const id="${FAKES.aws}";`,
    "github-token": `t:"${FAKES.github}"`,
    "slack-token": `hook="${FAKES.slack}"`,
    "stripe-secret-key": `key:"${FAKES.stripe}"`,
    "pem-private-key": `pk="${FAKES.pem}\\nMIIE..."`,
    jwt: `auth="${FAKES.jwt}"`,
    "credentialed-url": `u="${FAKES.dbUrl}"`,
    "generic-secret-assignment": `{client_secret:"${FAKES.generic}"}`,
  };
  for (const [rule, content] of Object.entries(cases)) {
    const hits = scanContent(content, "chunks/app.js");
    assert.ok(hits.some((h) => h.rule === rule), `expected ${rule} to fire for: ${content}`);
  }
});

test("Stellar seeds need a valid checksum; public keys and contract ids are ignored", () => {
  assert.equal(isValidStellarSecretSeed(FAKES.stellar), true);
  const tampered = FAKES.stellar.slice(0, -1) + (FAKES.stellar.endsWith("A") ? "B" : "A");
  assert.equal(isValidStellarSecretSeed(tampered), false);

  const publicIds = [
    "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI",
    "CAWXDSZM52E5BW7G6TFX7DTXSHF7F75TUSSWW7B442NBEU3CADXNVTXH",
  ];
  for (const id of publicIds) assert.deepEqual(scanContent(`a="${id}"`, "x.js"), []);
});

test("placeholders and low-entropy values do not trigger generic detection", () => {
  for (const content of [
    `{password:"password"}`,
    `{client_secret:"your_client_secret_here"}`,
    `{apiKey:"xxxxxxxxxxxxxxxxxxxx"}`,
    `{secret:"aaaaaaaaaaaaaaaaaaaa"}`,
    `u="http://localhost:3000/path"`,
    `u="postgres://user:changeme@localhost/db"`,
  ]) {
    assert.deepEqual(scanContent(content, "x.js"), [], content);
  }
});

test("findings carry line numbers", () => {
  const [hit] = scanContent(`line1\nline2\nk="${FAKES.aws}"`, "x.js");
  assert.equal(hit.line, 3);
});

// ── Bundle + source map scanning ────────────────────────────────────────────

test("a planted secret in the bundle fails the scan", () => {
  const root = tmp();
  write(root, "bundle/chunks/app.js", `console.log("ok");var s="${FAKES.stellar}";`);
  const result = run({ bundle: path.join(root, "bundle"), source: path.join(root, "missing"), nextConfig: path.join(root, "none"), allowlist: path.join(root, "none.json") }, {});
  assert.equal(result.blocking.length, 1);
  assert.equal(result.blocking[0].rule, "stellar-secret-seed");
  assert.equal(result.blocking[0].file, "chunks/app.js");
});

test("a planted secret inside a source map's app source is found; dependency sources are skipped by default", () => {
  const root = tmp();
  const map = {
    version: 3,
    sources: ["webpack://app/src/lib/config.ts", "webpack://app/node_modules/some-lib/index.js"],
    sourcesContent: [`export const KEY = "${FAKES.aws}";`, `const example = "${FAKES.github}";`],
  };
  write(root, "bundle/chunks/app.js.map", JSON.stringify(map));
  const base = { bundle: path.join(root, "bundle"), source: path.join(root, "missing"), nextConfig: path.join(root, "none"), allowlist: path.join(root, "none.json") };

  const result = run(base, {});
  assert.deepEqual(result.blocking.map((f) => f.rule), ["aws-access-key-id"]);
  assert.match(result.blocking[0].file, /app\.js\.map!webpack:\/\/app\/src\/lib\/config\.ts/);

  const withDeps = run({ ...base, includeDependencySources: true }, {});
  assert.equal(withDeps.blocking.length, 2);
});

test("a clean bundle passes", () => {
  const root = tmp();
  write(root, "bundle/chunks/app.js", `fetch("https://api.example.com/v1");const horizon="https://horizon-testnet.stellar.org";`);
  const result = run({ bundle: path.join(root, "bundle"), source: path.join(root, "missing"), nextConfig: path.join(root, "none"), allowlist: path.join(root, "none.json") }, {});
  assert.equal(result.blocking.length, 0);
});

test("server-only env values leaking into the bundle are caught, public ones are not", () => {
  const root = tmp();
  const leaked = "kQ8vZp2LxW9rT4nB7mC1";
  write(root, "bundle/chunks/app.js", `var a="${leaked}";var b="https://public.example.com/x";`);
  const env = {
    SESSION_SIGNING_SECRET: leaked,
    NEXT_PUBLIC_API_URL: "https://public.example.com/x",
    NODE_ENV: "production",
  };
  const result = run({ bundle: path.join(root, "bundle"), source: path.join(root, "missing"), nextConfig: path.join(root, "none"), allowlist: path.join(root, "none.json") }, env);
  const leak = result.blocking.find((f) => f.rule === "server-env-value-leak");
  assert.ok(leak);
  assert.equal(leak.envName, "SESSION_SIGNING_SECRET");
  assert.equal(result.blocking.some((f) => f.value === env.NEXT_PUBLIC_API_URL), false);
});

test("collectEnvSecrets skips public, short, boolean and allowlisted variables", () => {
  const secrets = collectEnvSecrets(
    {
      NEXT_PUBLIC_VAPID_KEY: "publicvalue12345678",
      JWT_SECRET: "short",
      FEATURE_TOKEN_ENABLED: "true",
      ADMIN_API_KEY: "a-long-enough-admin-key-123",
      INTERNAL_TOKEN: "another-long-internal-token-456",
    },
    ["INTERNAL_TOKEN"]
  );
  assert.deepEqual(secrets.map((s) => s.name), ["ADMIN_API_KEY"]);
});

// ── Allowlist ───────────────────────────────────────────────────────────────

test("public identifiers on the allowlist do not fail the scan", () => {
  const publicGoogleKey = "AIza" + "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q";
  const finding = scanContent(`maps="${publicGoogleKey}"`, "chunks/app.js")[0];
  assert.equal(finding.rule, "google-api-key");

  const byHash = { ...noAllowlist, hashes: [{ sha256: sha256(publicGoogleKey), reason: "Browser-restricted Maps key" }] };
  assert.deepEqual(evaluate({ findings: [finding], allowlist: byHash }).blocking, []);

  const byValue = { ...noAllowlist, values: [{ value: publicGoogleKey, rule: "google-api-key", reason: "Public" }] };
  assert.equal(evaluate({ findings: [finding], allowlist: byValue }).allowed[0].reason, "Public");

  const wrongRule = { ...noAllowlist, values: [{ value: publicGoogleKey, rule: "jwt", reason: "n/a" }] };
  assert.equal(evaluate({ findings: [finding], allowlist: wrongRule }).blocking.length, 1);

  const byFile = { ...noAllowlist, files: [{ path: "chunks/**", reason: "vendor" }] };
  assert.equal(evaluate({ findings: [finding], allowlist: byFile }).blocking.length, 0);
});

test("allowlist entries without a reason are rejected", () => {
  const root = tmp();
  write(root, "allow.json", JSON.stringify({ hashes: [{ sha256: "abc" }] }));
  assert.throws(() => loadAllowlist(path.join(root, "allow.json")), /reason/);
});

test("the committed allowlist is valid", () => {
  const allowlist = loadAllowlist(new URL("../devops/client-bundle-secret-allowlist.json", import.meta.url).pathname);
  assert.ok(Array.isArray(allowlist.hashes));
});

// ── Public prefix rules ─────────────────────────────────────────────────────

test("next.config env keys must use the public prefix", () => {
  const config = `const nextConfig = { env: { NEXT_PUBLIC_OK: "1", DATABASE_URL: process.env.DATABASE_URL, nested: { A: 1 } }, other: { X: 1 } };`;
  assert.deepEqual(extractNextConfigEnvKeys(config), ["NEXT_PUBLIC_OK", "DATABASE_URL", "nested"]);
  assert.deepEqual(extractNextConfigEnvKeys(`const c = {};`), []);
});

test("client components may only read NEXT_PUBLIC_ variables", () => {
  const root = tmp();
  write(root, "src/components/Widget.tsx", `"use client";\nexport const a = process.env.ADMIN_API_KEY;\nexport const b = process.env.NEXT_PUBLIC_API_URL;\nexport const c = process.env.NODE_ENV;`);
  write(root, "src/app/api/route.ts", `export const a = process.env.ADMIN_API_KEY;`);
  write(root, "src/components/__tests__/w.test.tsx", `"use client";\nprocess.env.SOMETHING_SECRET;`);
  const findings = checkPublicPrefix({ sourceDir: path.join(root, "src") });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].value, "ADMIN_API_KEY");
  assert.match(findings[0].file, /Widget\.tsx$/);
  assert.equal(findings[0].line, 2);
});

test("NEXT_PUBLIC_ variables whose names suggest secrets are flagged", () => {
  const root = tmp();
  write(root, "src/lib/a.ts", `export const a = process.env.NEXT_PUBLIC_ADMIN_SECRET;\nexport const b = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;\nexport const c = process.env["NEXT_PUBLIC_SENTRY_DSN"];`);
  const findings = checkPublicPrefix({ sourceDir: path.join(root, "src") });
  assert.deepEqual(findings.map((f) => f.value), ["NEXT_PUBLIC_ADMIN_SECRET"]);
});

test("env read and use-client helpers", () => {
  assert.deepEqual(extractEnvReads(`process.env.A; process.env["B"]; process.env.A`).sort(), ["A", "B"]);
  assert.equal(isClientSource(`// c\n"use client";\nx`), true);
  assert.equal(isClientSource(`import x from "y";\n"use client";`), false);
});

// ── Reporting ───────────────────────────────────────────────────────────────

test("reports never print the full secret", () => {
  const findings = scanContent(`k="${FAKES.github}"`, "chunks/app.js");
  const report = renderReport({ ...evaluate({ findings, allowlist: noAllowlist }), filesScanned: 1 });
  assert.equal(report.includes(FAKES.github), false);
  assert.ok(report.includes(sha256(FAKES.github)));
  assert.equal(redact("short"), "*****");
});

// ── CLI ─────────────────────────────────────────────────────────────────────

test("CLI exits 2 on a planted secret, 0 when clean, 1 when the bundle is missing", () => {
  const root = tmp();
  const script = new URL("./client-bundle-secret-scan.mjs", import.meta.url).pathname;
  const common = ["--source", path.join(root, "nosrc"), "--next-config", path.join(root, "none"), "--allowlist", path.join(root, "none.json")];
  const cli = (...extra) => spawnSync(process.execPath, [script, ...common, ...extra], { encoding: "utf8", env: { PATH: process.env.PATH } });

  write(root, "dirty/chunks/app.js", `var s="${FAKES.stellar}";`);
  const dirty = cli("--bundle", path.join(root, "dirty"));
  assert.equal(dirty.status, 2);
  assert.equal(dirty.stdout.includes(FAKES.stellar) || dirty.stderr.includes(FAKES.stellar), false);

  write(root, "clean/chunks/app.js", `var s="hello";`);
  assert.equal(cli("--bundle", path.join(root, "clean")).status, 0);

  assert.equal(cli("--bundle", path.join(root, "absent")).status, 1);
});
