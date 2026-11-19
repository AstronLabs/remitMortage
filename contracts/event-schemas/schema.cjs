// Extracts the events each Soroban contract publishes from its Rust source and
// compares them with the golden fixtures in this directory
// (contracts/event-schemas/<contract>.json). The indexer decodes these events
// positionally, so removing or reordering a topic/data field is a breaking
// change that must be recorded with a schemaVersion bump.
//
// CLI:
//   node contracts/event-schemas/schema.cjs check
//   node contracts/event-schemas/schema.cjs update                    # additive changes only
//   node contracts/event-schemas/schema.cjs update --breaking "<why>" # bumps schemaVersion
//
// See docs/EVENT_SCHEMA_COMPATIBILITY.md.

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CONTRACTS_DIR = path.resolve(__dirname, "..");
const SCHEMAS_DIR = __dirname;

// ── Rust source scanning ────────────────────────────────────────────────────

function stripComments(src) {
  return src.replace(/^\s*\/\/.*$/gm, "");
}

/** Removes `#[cfg(test)] mod x { ... }` blocks so test-only events are ignored. */
function stripTestModules(src) {
  let out = "";
  let i = 0;
  const marker = "#[cfg(test)]";
  for (;;) {
    const at = src.indexOf(marker, i);
    if (at === -1) return out + src.slice(i);
    out += src.slice(i, at);
    let j = at + marker.length;
    while (j < src.length && src[j] !== "{" && src[j] !== ";") j++;
    if (src[j] === ";") {
      i = j + 1;
    } else {
      i = matchClose(src, j) + 1;
    }
  }
}

/** Index of the bracket closing the one at `open` (string-literal aware). */
function matchClose(src, open) {
  const pairs = { "(": ")", "{": "}", "[": "]" };
  const stack = [pairs[src[open]]];
  let i = open + 1;
  while (i < src.length && stack.length) {
    const c = src[i];
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
    } else if (pairs[c]) {
      stack.push(pairs[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
    }
    i++;
  }
  if (stack.length) throw new Error("unbalanced brackets in contract source");
  return i - 1;
}

/** Splits on commas that are not nested inside brackets or string literals. */
function splitTopLevel(expr) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"') {
      const start = i;
      i++;
      while (i < expr.length && expr[i] !== '"') i += expr[i] === "\\" ? 2 : 1;
      cur += expr.slice(start, i + 1);
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function unwrapParens(expr) {
  const e = expr.trim();
  if (e.startsWith("(") && matchClose(e, 0) === e.length - 1) return e.slice(1, -1);
  return null;
}

const SYMBOL_LITERAL = /^(?:soroban_sdk::)?symbol_short!\(\s*"([^"]+)"\s*\)$|^Symbol::new\(\s*&?env\s*,\s*"([^"]+)"\s*\)$/;

/** `symbol_short!("x")` / `Symbol::new(&env, "x")` → "x", otherwise null. */
function symbolLiteral(expr) {
  const m = SYMBOL_LITERAL.exec(expr.trim());
  return m ? m[1] ?? m[2] : null;
}

/** A stable, rename-sensitive name for a field expression. */
function fieldName(expr) {
  let e = expr.replace(/\s+/g, " ").trim();
  const literal = symbolLiteral(e);
  if (literal !== null) return `"${literal}"`;
  e = e.replace(/^&/, "").replace(/\.clone\(\)/g, "");
  const path = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.exec(e);
  return path ? e.split(".").pop() : e;
}

function parsePublish(args) {
  const [topicsExpr, dataExpr] = splitTopLevel(args);
  if (topicsExpr === undefined || dataExpr === undefined) return null;
  const topicInner = unwrapParens(topicsExpr);
  const topicParts = splitTopLevel(topicInner ?? topicsExpr);
  const name = symbolLiteral(topicParts[0]);
  if (name === null) return null;

  const topicArgs = topicParts.slice(1).map(fieldName);
  const dataInner = unwrapParens(dataExpr);
  const tuple = dataInner !== null && (dataInner.trim() === "" || splitTopLevel(dataInner).length > 0);
  const data = tuple ? splitTopLevel(dataInner).map(fieldName) : [fieldName(dataExpr)];
  return { name, topicArgs, dataKind: tuple ? "tuple" : "value", data };
}

function extractFromSource(src) {
  const code = stripTestModules(stripComments(src));
  const found = [];
  const re = /\.publish\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(code, open);
    const ev = parsePublish(code.slice(open + 1, close));
    if (ev) found.push(ev);
    re.lastIndex = close;
  }
  return found;
}

function isTestFile(file) {
  return /(^|[\\/])(tests?|fuzz)[\\/]|(^|_)(tests?|fuzz)(_|\.rs$)|test_|_test/.test(file);
}

function listRustSources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRustSources(p));
    else if (entry.name.endsWith(".rs") && !isTestFile(entry.name)) out.push(p);
  }
  return out.sort();
}

/** Event key: topic name plus any literal sub-topics, e.g. "milestone/full". */
function eventKey(ev) {
  const literals = ev.topicArgs.filter((a) => a.startsWith('"')).map((a) => a.slice(1, -1));
  return [ev.name, ...literals].join("/");
}

function shapeOf(ev) {
  return { topicArgs: ev.topicArgs, dataKind: ev.dataKind, data: ev.data };
}

function sameShape(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @returns {Record<string, Record<string, object[]>>} contract → eventKey → shapes */
function extractAll(contractsDir = CONTRACTS_DIR) {
  const result = {};
  for (const entry of fs.readdirSync(contractsDir, { withFileTypes: true })) {
    const srcDir = path.join(contractsDir, entry.name, "src");
    if (!entry.isDirectory() || !fs.existsSync(srcDir)) continue;
    const events = {};
    for (const file of listRustSources(srcDir)) {
      for (const ev of extractFromSource(fs.readFileSync(file, "utf8"))) {
        const key = eventKey(ev);
        const shapes = (events[key] ??= []);
        if (!shapes.some((s) => sameShape(s, shapeOf(ev)))) shapes.push(shapeOf(ev));
      }
    }
    if (Object.keys(events).length) result[entry.name] = sortEvents(events);
  }
  return result;
}

function sortEvents(events) {
  return Object.fromEntries(Object.keys(events).sort().map((k) => [k, events[k]]));
}

// ── Golden fixtures ─────────────────────────────────────────────────────────

function fixturePath(contract, schemasDir = SCHEMAS_DIR) {
  return path.join(schemasDir, `${contract}.json`);
}

function loadFixtures(schemasDir = SCHEMAS_DIR) {
  const out = {};
  for (const f of fs.readdirSync(schemasDir)) {
    if (f.endsWith(".json")) out[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(schemasDir, f), "utf8"));
  }
  return out;
}

/**
 * Compares a golden fixture's events with the events currently in source.
 * breaking: something the indexer may rely on was removed or changed.
 * additive: something new appeared that the fixture does not know about yet.
 */
function diffEvents(golden, current) {
  const breaking = [];
  const additive = [];
  for (const [key, shapes] of Object.entries(golden)) {
    const now = current[key];
    if (!now) {
      breaking.push(`event "${key}" was removed or renamed`);
      continue;
    }
    for (const shape of shapes) {
      if (!now.some((s) => sameShape(s, shape))) {
        breaking.push(`event "${key}" changed: expected ${describe(shape)} but source now has ${now.map(describe).join(" | ")}`);
      }
    }
    for (const s of now) {
      if (!shapes.some((g) => sameShape(g, s))) additive.push(`event "${key}" gained shape ${describe(s)}`);
    }
  }
  for (const key of Object.keys(current)) {
    if (!golden[key]) additive.push(`new event "${key}"`);
  }
  return { breaking, additive };
}

function describe(shape) {
  const topics = shape.topicArgs.length ? `topics[${shape.topicArgs.join(", ")}]` : "topics[]";
  return `${topics} data(${shape.dataKind})[${shape.data.join(", ")}]`;
}

/** Problems with the version bookkeeping inside a fixture itself. */
function versionProblems(fixture) {
  const problems = [];
  const changes = fixture.changes ?? [];
  const last = changes[changes.length - 1];
  if (!Number.isInteger(fixture.schemaVersion) || fixture.schemaVersion < 1) {
    problems.push("schemaVersion must be a positive integer");
  } else if (!last || last.version !== fixture.schemaVersion) {
    problems.push(`schemaVersion ${fixture.schemaVersion} has no matching entry at the end of "changes"`);
  }
  for (let i = 1; i < changes.length; i++) {
    if (changes[i].version <= changes[i - 1].version) problems.push('"changes" versions must be strictly increasing');
  }
  return problems;
}

// ── Topic naming convention (issue #857) ────────────────────────────────────
//
// Every event identifier is lower_snake_case: the on-chain topic symbol and
// each literal sub-topic segment in the catalog key. Soroban symbols are at
// most 32 characters. See docs/EVENT_TOPIC_CONVENTION.md.
const TOPIC_SEGMENT = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Naming-convention problems for one contract's extracted events. Returns an
 * array of human-readable messages; empty means every event conforms.
 */
function conventionProblems(contract, events) {
  const problems = [];
  for (const key of Object.keys(events)) {
    const segments = key.split("/");
    for (const segment of segments) {
      if (!TOPIC_SEGMENT.test(segment)) {
        problems.push(
          `event "${key}" has a non-conforming topic segment "${segment}" ` +
            `(expected lower_snake_case, 1-32 chars, starting with a letter)`,
        );
      }
    }
    if (!contract) problems.push("fixture is missing a contract name");
  }
  return problems;
}

function newFixture(contract, events) {
  return {
    contract,
    schemaVersion: 1,
    changes: [{ version: 1, summary: "Initial baseline" }],
    events,
  };
}

/**
 * Computes the fixtures that `update` would write. Throws when a breaking change
 * is present and no `breakingReason` was supplied.
 */
function planUpdate(fixtures, current, breakingReason) {
  const next = {};
  for (const [contract, events] of Object.entries(current)) {
    const old = fixtures[contract];
    if (!old) {
      next[contract] = newFixture(contract, events);
      continue;
    }
    const { breaking } = diffEvents(old.events, events);
    if (breaking.length && !breakingReason) {
      throw new Error(
        `${contract}: breaking event schema change(s):\n  - ${breaking.join("\n  - ")}\n` +
          `If intentional, re-run with --breaking "<reason>" to bump schemaVersion and record it.`,
      );
    }
    const updated = { ...old, events };
    if (breaking.length) {
      updated.schemaVersion = old.schemaVersion + 1;
      updated.changes = [...old.changes, { version: updated.schemaVersion, summary: breakingReason }];
    }
    next[contract] = updated;
  }
  return next;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function runCli(argv) {
  const [cmd, ...rest] = argv;
  const current = extractAll();
  const fixtures = loadFixtures();

  if (cmd === "check") {
    let failed = false;
    for (const [contract, events] of Object.entries(current)) {
      const fx = fixtures[contract];
      if (!fx) {
        console.error(`${contract}: no fixture (run update)`);
        failed = true;
        continue;
      }
      const { breaking, additive } = diffEvents(fx.events, events);
      const convention = conventionProblems(contract, events);
      for (const msg of breaking) console.error(`${contract}: BREAKING ${msg}`);
      for (const msg of additive) console.error(`${contract}: fixture out of date: ${msg}`);
      for (const msg of versionProblems(fx)) console.error(`${contract}: ${msg}`);
      for (const msg of convention) console.error(`${contract}: CONVENTION ${msg}`);
      if (
        breaking.length ||
        additive.length ||
        versionProblems(fx).length ||
        convention.length
      ) {
        failed = true;
      }
    }
    process.exit(failed ? 1 : 0);
  }

  if (cmd === "catalog") {
    const rows = [];
    for (const contract of Object.keys(fixtures).sort()) {
      const fixture = fixtures[contract];
      for (const key of Object.keys(fixture.events).sort()) {
        const shapes = fixture.events[key].map(describe).join("<br>");
        rows.push(`| ${contract} | \`${key}\` | ${shapes} |`);
      }
    }
    const text = [
      "# Event Catalog",
      "",
      "Generated from `contracts/event-schemas/*.json` by",
      "`node contracts/event-schemas/schema.cjs catalog`. **Do not edit by hand.**",
      "Every event follows the naming convention in",
      "`docs/EVENT_TOPIC_CONVENTION.md`.",
      "",
      "| Contract | Event | Topics and payload (positional) |",
      "|---|---|---|",
      ...rows,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(SCHEMAS_DIR, "CATALOG.md"), text);
    console.log(`wrote CATALOG.md (${rows.length} events)`);
    return;
  }

  if (cmd === "update") {
    const i = rest.indexOf("--breaking");
    const reason = i === -1 ? undefined : rest[i + 1];
    if (i !== -1 && !reason) throw new Error("--breaking requires a reason");

    // Refuse to bake a non-conforming topic into the fixtures.
    for (const [contract, events] of Object.entries(current)) {
      const problems = conventionProblems(contract, events);
      if (problems.length) {
        throw new Error(`${contract}: naming convention violation:\n  - ${problems.join("\n  - ")}`);
      }
    }

    const next = planUpdate(fixtures, current, reason);
    for (const [contract, fx] of Object.entries(next)) {
      fs.writeFileSync(fixturePath(contract), JSON.stringify(fx, null, 2) + "\n");
    }
    console.log(`wrote ${Object.keys(next).length} event schema fixture(s)`);
    return;
  }

  console.error('usage: schema.cjs check | catalog | update [--breaking "<reason>"]');
  process.exit(2);
}

module.exports = {
  CONTRACTS_DIR,
  SCHEMAS_DIR,
  extractFromSource,
  extractAll,
  loadFixtures,
  diffEvents,
  versionProblems,
  conventionProblems,
  planUpdate,
  eventKey,
};

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
