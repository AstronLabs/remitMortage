#!/usr/bin/env node
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Client bundle secret scan (issue #933).
 *
 * Anything bundled into the frontend is public. This script fails the build
 * when the built client bundle (and its source maps) contain secret-like
 * strings or known key formats, or when a variable that is not
 * `NEXT_PUBLIC_*` is exposed to the browser.
 *
 * Checks
 *   1. Bundle scan   - known key formats (Stellar secret seeds, AWS, GitHub,
 *                      Slack, Stripe, SendGrid, PEM private keys, JWTs,
 *                      credentialed URLs, ...) plus high-entropy values
 *                      assigned to secret-named keys.
 *   2. Env leak      - the *values* of server-only, secret-named environment
 *                      variables must not appear anywhere in the bundle.
 *   3. Public prefix - `next.config` `env:` entries and `process.env.X`
 *                      reads in `"use client"` source must use NEXT_PUBLIC_*;
 *                      NEXT_PUBLIC_* names must not look like secrets.
 *
 * Findings are matched against a reviewed allowlist
 * (devops/client-bundle-secret-allowlist.json). Allowlist entries identify a
 * match by SHA-256 (so the allowlist never stores a secret) or, for public
 * identifiers, by literal value. Secrets are never printed: reports show a
 * redacted preview plus the hash to use when adding a reviewed entry.
 *
 * Usage
 *   node scripts/client-bundle-secret-scan.mjs [--bundle frontend/.next/static]
 *        [--source frontend/src] [--next-config frontend/next.config.ts]
 *        [--allowlist devops/client-bundle-secret-allowlist.json]
 *        [--env-file path]... [--report report.md]
 *        [--include-dependency-sources]
 *   exit 0 = clean, 2 = findings, 1 = error
 *   (writes `findings` to $GITHUB_OUTPUT, summary to $GITHUB_STEP_SUMMARY)
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PUBLIC_PREFIX = "NEXT_PUBLIC_";

const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".map", ".css", ".html", ".json", ".txt"]);
const SERVER_ENV_SECRET_NAME =
  /(SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|TOKEN|API_?KEY|ACCESS_?KEY|SIGNING|ENCRYPTION|DATABASE_URL|DSN_SECRET|_KEY$|^KEY$)/i;
const PUBLIC_NAME_LOOKS_SECRET =
  /(SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH_?TOKEN|ACCESS_?TOKEN|API_?KEY|SIGNING_?KEY|ENCRYPTION)/i;
const PUBLIC_NAME_SAFE = /(PUBLIC_?KEY|PUBLISHABLE|PUBLIC_?ID)/i;
/** Variables that Next.js / the platform legitimately inline into client code. */
const DEFAULT_ALLOWED_ENV = new Set(["NODE_ENV", "NEXT_RUNTIME", "NEXT_PHASE"]);
const MIN_ENV_LEAK_LENGTH = 12;

// ---------------------------------------------------------------------------
// Detection rules
// ---------------------------------------------------------------------------

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16Xmodem(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32Decode(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of text) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** True for a checksum-valid Stellar secret seed (S...), the only form that can sign. */
export function isValidStellarSecretSeed(candidate) {
  if (!/^S[A-Z2-7]{55}$/.test(candidate)) return false;
  const bytes = base32Decode(candidate);
  if (!bytes || bytes.length !== 35 || bytes[0] !== 18 << 3) return false;
  const checksum = bytes[33] | (bytes[34] << 8);
  return crc16Xmodem(bytes.subarray(0, 33)) === checksum;
}

export function shannonEntropy(text) {
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER = /^(?:x+|\*+|your[_-]|changeme|change_me|example|placeholder|dummy|test|none|null|undefined|true|false|process\.env)/i;

export const RULES = [
  {
    id: "stellar-secret-seed",
    description: "Stellar secret seed (can sign transactions)",
    regex: /\bS[A-Z2-7]{55}\b/g,
    validate: (match) => isValidStellarSecretSeed(match),
  },
  { id: "pem-private-key", description: "PEM private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "aws-access-key-id", description: "AWS access key id", regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  {
    id: "aws-secret-access-key",
    description: "AWS secret access key",
    regex: /aws_?secret_?access_?key["'\s:=]{1,6}([A-Za-z0-9/+=]{40})\b/gi,
    group: 1,
  },
  { id: "github-token", description: "GitHub token", regex: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { id: "slack-token", description: "Slack token", regex: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/g },
  { id: "stripe-secret-key", description: "Stripe secret/restricted key", regex: /\b[sr]k_live_[0-9a-zA-Z]{16,}\b/g },
  { id: "sendgrid-api-key", description: "SendGrid API key", regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { id: "anthropic-api-key", description: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-api-key", description: "OpenAI-style API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { id: "npm-token", description: "npm access token", regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: "sentry-auth-token", description: "Sentry auth token", regex: /\bsntrys_[A-Za-z0-9+/=_-]{40,}\b/g },
  { id: "google-api-key", description: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    id: "jwt",
    description: "JSON Web Token",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: "credentialed-url",
    description: "URL with embedded credentials",
    regex: /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s/:@"'`\\]{1,64}:([^\s/@"'`\\]{3,})@[^\s"'`\\]+/gi,
    group: 1,
    validate: (secret) => !PLACEHOLDER.test(secret),
  },
  {
    id: "generic-secret-assignment",
    description: "High-entropy value assigned to a secret-named key",
    regex:
      /\b[\w.-]{0,40}(?:secret|passw(?:or)?d|private[_-]?key|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret|signing[_-]?key)[\w.-]{0,20}["'`]?\s*[:=]\s*["'`]([^"'`\s\\]{16,})["'`]/gi,
    group: 1,
    validate: (value) =>
      !PLACEHOLDER.test(value) &&
      !/^[a-z]+$/i.test(value) &&
      /\d/.test(value) &&
      /[a-z]/i.test(value) &&
      shannonEntropy(value) >= 3.5,
  },
];

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function redact(value) {
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
}

export function loadAllowlist(file) {
  if (!file || !fs.existsSync(file)) return { values: [], hashes: [], files: [], env: [] };
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const entries = (list) => (Array.isArray(list) ? list : []);
  for (const entry of [...entries(raw.values), ...entries(raw.hashes), ...entries(raw.files)]) {
    if (!entry.reason) throw new Error(`Allowlist entry ${JSON.stringify(entry)} must include a "reason".`);
  }
  return {
    values: entries(raw.values),
    hashes: entries(raw.hashes),
    files: entries(raw.files),
    env: entries(raw.env),
  };
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped.replace(/\u0000/g, ".*")}$`);
}

/** Reason the finding is allowlisted, or null. */
export function allowlistReason(finding, allowlist) {
  const applies = (entry) => !entry.rule || entry.rule === finding.rule;
  const hash = sha256(finding.value);
  for (const entry of allowlist.hashes) {
    if (applies(entry) && entry.sha256 === hash) return entry.reason;
  }
  for (const entry of allowlist.values) {
    if (applies(entry) && entry.value === finding.value) return entry.reason;
  }
  for (const entry of allowlist.files) {
    if (applies(entry) && globToRegExp(entry.path).test(finding.file)) return entry.reason;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content scanning
// ---------------------------------------------------------------------------

function lineOf(content, index) {
  let line = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < index; i = content.indexOf("\n", i + 1)) line++;
  return line;
}

/** Scan one blob of text with every rule; returns raw findings. */
export function scanContent(content, file) {
  const findings = [];
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (let m = rule.regex.exec(content); m; m = rule.regex.exec(content)) {
      const value = rule.group ? m[rule.group] : m[0];
      if (rule.validate && !rule.validate(value)) continue;
      findings.push({ rule: rule.id, description: rule.description, file, line: lineOf(content, m.index), value });
    }
  }
  return findings;
}

/** Scan for the literal values of server-only secrets that must never be bundled. */
export function scanForEnvValues(content, file, envSecrets) {
  const findings = [];
  for (const { name, value } of envSecrets) {
    const index = content.indexOf(value);
    if (index !== -1) {
      findings.push({
        rule: "server-env-value-leak",
        description: `Value of server-only variable ${name} is present in the client bundle`,
        file,
        line: lineOf(content, index),
        value,
        envName: name,
      });
    }
  }
  return findings;
}

/** Server-only, secret-named environment variables worth searching the bundle for. */
export function collectEnvSecrets(env, allowedEnv = []) {
  const allowed = new Set([...DEFAULT_ALLOWED_ENV, ...allowedEnv]);
  return Object.entries(env)
    .filter(
      ([name, value]) =>
        !name.startsWith(PUBLIC_PREFIX) &&
        !allowed.has(name) &&
        SERVER_ENV_SECRET_NAME.test(name) &&
        typeof value === "string" &&
        value.length >= MIN_ENV_LEAK_LENGTH &&
        !/^(true|false|https?:\/\/[^@]*$)/i.test(value)
    )
    .map(([name, value]) => ({ name, value }));
}

export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

/** Yield `{ file, content }` units for a bundle file; source maps are expanded per source. */
export function* bundleUnits(file, relative, { includeDependencySources = false } = {}) {
  const content = fs.readFileSync(file, "utf8");
  if (!file.endsWith(".map")) {
    yield { file: relative, content };
    return;
  }
  let map;
  try {
    map = JSON.parse(content);
  } catch {
    yield { file: relative, content };
    return;
  }
  const sources = map.sources ?? [];
  const contents = map.sourcesContent ?? [];
  for (let i = 0; i < contents.length; i++) {
    const source = String(sources[i] ?? `source-${i}`);
    if (typeof contents[i] !== "string") continue;
    if (!includeDependencySources && /(^|\/)node_modules\//.test(source)) continue;
    yield { file: `${relative}!${source}`, content: contents[i] };
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name))) yield full;
  }
}

export function scanBundle(dir, { envSecrets = [], includeDependencySources = false } = {}) {
  const findings = [];
  let filesScanned = 0;
  for (const file of walk(dir)) {
    filesScanned++;
    const relative = path.relative(dir, file).split(path.sep).join("/");
    for (const unit of bundleUnits(file, relative, { includeDependencySources })) {
      findings.push(...scanContent(unit.content, unit.file), ...scanForEnvValues(unit.content, unit.file, envSecrets));
    }
  }
  return { findings, filesScanned };
}

// ---------------------------------------------------------------------------
// Public-prefix checks
// ---------------------------------------------------------------------------

/** Keys of the `env: { ... }` object in next.config, which Next inlines into the client bundle. */
export function extractNextConfigEnvKeys(source) {
  const start = source.search(/\benv\s*:\s*\{/);
  if (start === -1) return [];
  let depth = 0;
  let i = source.indexOf("{", start);
  const bodyStart = i + 1;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  const body = source.slice(bodyStart, i);
  const keys = [];
  let level = 0;
  for (const part of body.split(/(?<=[,{}])/)) {
    const m = part.match(/^\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*:/);
    if (m && level === 0) keys.push(m[1]);
    for (const char of part) level += char === "{" ? 1 : char === "}" ? -1 : 0;
  }
  return keys;
}

/** `process.env.X` / `process.env["X"]` names read in a source file. */
export function extractEnvReads(source) {
  const names = new Set();
  for (const m of source.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  for (const m of source.matchAll(/process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g)) names.add(m[1]);
  return [...names];
}

export const isClientSource = (source) => /^\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\n]*\n\s*)*["']use client["']/.test(source);

function* walkSource(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== "__tests__") yield* walkSource(full);
    } else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name)) {
      yield full;
    }
  }
}

/** Checks 3a/3b: variable naming and exposure rules. Returns findings with `rule: "public-prefix"`. */
export function checkPublicPrefix({ sourceDir, nextConfigFile, allowedEnv = [] }) {
  const allowed = new Set([...DEFAULT_ALLOWED_ENV, ...allowedEnv]);
  const findings = [];
  const add = (file, line, description, value) =>
    findings.push({ rule: "public-prefix", description, file, line, value });

  if (nextConfigFile && fs.existsSync(nextConfigFile)) {
    const configSource = fs.readFileSync(nextConfigFile, "utf8");
    for (const key of extractNextConfigEnvKeys(configSource)) {
      if (!key.startsWith(PUBLIC_PREFIX) && !allowed.has(key)) {
        add(nextConfigFile, 1, `next.config "env" exposes ${key} to the browser; rename it with the ${PUBLIC_PREFIX} prefix or remove it`, key);
      }
    }
  }

  if (sourceDir && fs.existsSync(sourceDir)) {
    const seenPublic = new Map();
    for (const file of walkSource(sourceDir)) {
      const source = fs.readFileSync(file, "utf8");
      const client = isClientSource(source);
      for (const name of extractEnvReads(source)) {
        if (name.startsWith(PUBLIC_PREFIX)) {
          if (!seenPublic.has(name)) seenPublic.set(name, file);
        } else if (client && !allowed.has(name)) {
          add(file, lineOf(source, source.indexOf(`process.env.${name}`) + 1), `Client component reads ${name}, which is not exposed to the browser (${PUBLIC_PREFIX} prefix required)`, name);
        }
      }
    }
    for (const [name, file] of seenPublic) {
      const suffix = name.slice(PUBLIC_PREFIX.length);
      if (PUBLIC_NAME_LOOKS_SECRET.test(suffix) && !PUBLIC_NAME_SAFE.test(suffix)) {
        add(file, 1, `${name} is exposed to every visitor but its name suggests a secret`, name);
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Orchestration + reporting
// ---------------------------------------------------------------------------

export function evaluate({ findings, allowlist }) {
  const blocking = [];
  const allowed = [];
  for (const finding of findings) {
    const reason = allowlistReason(finding, allowlist);
    if (reason) allowed.push({ ...finding, reason });
    else blocking.push(finding);
  }
  return { blocking, allowed };
}

export function renderReport({ blocking, allowed, filesScanned }) {
  const lines = [`## Client bundle secret scan`, ``, `Scanned ${filesScanned} bundle file(s): **${blocking.length}** blocking finding(s), ${allowed.length} allowlisted.`, ``];
  if (blocking.length > 0) {
    lines.push(`| Rule | Location | Preview | SHA-256 (for reviewed allowlist) |`, `| --- | --- | --- | --- |`);
    for (const f of blocking) {
      lines.push(`| \`${f.rule}\` | \`${f.file}:${f.line}\` | \`${redact(f.value)}\` | \`${sha256(f.value)}\` |`);
    }
    lines.push(
      ``,
      `If a match is a public identifier, add its hash to \`devops/client-bundle-secret-allowlist.json\` with a reason. Otherwise remove it from the client code and rotate it.`
    );
  } else {
    lines.push(`No secret-like strings found outside the reviewed allowlist.`);
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  const args = { envFiles: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = () => argv[++i];
    if (key === "--bundle") args.bundle = value();
    else if (key === "--source") args.source = value();
    else if (key === "--next-config") args.nextConfig = value();
    else if (key === "--allowlist") args.allowlist = value();
    else if (key === "--report") args.report = value();
    else if (key === "--env-file") args.envFiles.push(value());
    else if (key === "--include-dependency-sources") args.includeDependencySources = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  return args;
}

export function run(args, env = process.env) {
  const bundle = args.bundle ?? "frontend/.next/static";
  if (!fs.existsSync(bundle)) {
    throw new Error(`Bundle directory not found: ${bundle}. Build the frontend first (npm run build).`);
  }
  const allowlist = loadAllowlist(args.allowlist ?? "devops/client-bundle-secret-allowlist.json");
  const mergedEnv = { ...env };
  // safe-merge-ok: CI-only scan; env files are repo-tracked paths passed on the command line, never request data
  for (const file of args.envFiles ?? []) Object.assign(mergedEnv, parseEnvFile(fs.readFileSync(file, "utf8")));

  const envSecrets = collectEnvSecrets(mergedEnv, allowlist.env);
  const { findings, filesScanned } = scanBundle(bundle, {
    envSecrets,
    includeDependencySources: args.includeDependencySources,
  });
  findings.push(
    ...checkPublicPrefix({
      sourceDir: args.source ?? "frontend/src",
      nextConfigFile: args.nextConfig ?? "frontend/next.config.ts",
      allowedEnv: allowlist.env,
    })
  );
  const result = evaluate({ findings, allowlist });
  return { ...result, filesScanned };
}

function main() {
  let result;
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    result = run(args);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
  const report = renderReport(result);
  console.log(report);
  if (args.report) fs.writeFileSync(args.report, report);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${result.blocking.length > 0}\n`);
  if (result.blocking.length > 0) {
    for (const f of result.blocking) {
      console.error(`::error file=${f.file},line=${f.line}::${f.rule}: ${f.description} (${redact(f.value)})`);
    }
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
