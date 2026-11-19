// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Prototype-pollution and unsafe-deserialization guards (issue #885).
 *
 * Three layers, each independently sufficient for the payloads it sees:
 *
 *   1. **Strip at the edge.** {@link sanitizeDeep} removes `__proto__`,
 *      `constructor` and `prototype` keys from anything that arrives over the
 *      wire, before a single handler reads it. `middleware/prototypePollutionGuard.ts`
 *      runs it on every request body, query and route param.
 *   2. **Merge safely.** {@link safeMerge} and {@link safeAssign} are the only
 *      sanctioned ways to fold one object's keys into another. They refuse the
 *      three dangerous keys and never walk into a prototype, so even an
 *      unsanitised source cannot reach a shared prototype.
 *      `scripts/check-unsafe-merge.mjs` fails CI on a hand-rolled merge.
 *   3. **Freeze what is shared.** {@link freezeCriticalPrototypes} seals
 *      `Object.prototype` and friends at startup, so a gap in layers 1–2
 *      throws (or silently no-ops) instead of changing behaviour process-wide.
 *
 * `JSON.parse` itself does not pollute a prototype — it creates `__proto__` as
 * an *own* data property — but that own property becomes live pollution the
 * moment a naive deep merge copies it with `target[key] = source[key]`. That is
 * why {@link safeParseJson} exists: it parses and sanitises in one step so the
 * dangerous own property never leaves the parser.
 */

/** Keys that can reach a shared prototype and are never legitimate input. */
export const POLLUTION_KEYS = ["__proto__", "constructor", "prototype"] as const;

export type PollutionKey = (typeof POLLUTION_KEYS)[number];

const POLLUTION_KEY_SET: ReadonlySet<string> = new Set<string>(POLLUTION_KEYS);

/** Depth cap for the recursive walk; deeper nesting is left untouched. */
const MAX_DEPTH = 32;

/** True when `key` is one of the three keys that can mutate a prototype. */
export function isPollutionKey(key: string): boolean {
  return POLLUTION_KEY_SET.has(key);
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  // Dates, Buffers, streams and class instances are left alone — only
  // structures a JSON body can produce are walked.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export interface SanitizeResult<T> {
  /** The same reference that was passed in, with dangerous keys removed. */
  value: T;
  /** Dot-paths of every key that was removed, for logging and audit. */
  stripped: string[];
}

/**
 * Removes every `__proto__` / `constructor` / `prototype` own key from `value`,
 * recursively, **in place**.
 *
 * Mutating rather than rebuilding is deliberate: `req.body` and `req.query` are
 * read by reference all over Express, and replacing them would strand
 * middleware that captured the original object.
 */
export function sanitizeDeep<T>(value: T): SanitizeResult<T> {
  const stripped: string[] = [];
  walk(value, "", stripped, new WeakSet<object>(), 0);
  return { value, stripped };
}

function walk(
  value: unknown,
  path: string,
  stripped: string[],
  seen: WeakSet<object>,
  depth: number
): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      walk(value[i], `${path}[${i}]`, stripped, seen, depth + 1);
    }
    return;
  }

  if (!isPlainContainer(value)) return;

  // getOwnPropertyNames (not Object.keys) so a non-enumerable `__proto__`
  // planted by a hand-rolled parser is caught too.
  for (const key of Object.getOwnPropertyNames(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (isPollutionKey(key)) {
      // `delete` is correct here: JSON.parse creates `__proto__` as an own
      // data property, so there is a real own property to remove.
      delete (value as Record<string, unknown>)[key];
      stripped.push(childPath);
      continue;
    }
    walk((value as Record<string, unknown>)[key], childPath, stripped, seen, depth + 1);
  }
}

/** True when `value` (or anything nested in it) carries a pollution key. */
export function hasPollutionKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((entry) => hasPollutionKey(entry, depth + 1));
  if (!isPlainContainer(value)) return false;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (isPollutionKey(key)) return true;
    if (hasPollutionKey((value as Record<string, unknown>)[key], depth + 1)) return true;
  }
  return false;
}

/**
 * `JSON.parse` that cannot hand back a pollution key.
 *
 * Use this for every string that did not originate in this process: request
 * bodies already parsed by Express are covered by the middleware, but webhook
 * payloads, queue messages, cached blobs and imported files all arrive as text
 * and must come through here.
 *
 * @throws SyntaxError when `text` is not valid JSON — same as `JSON.parse`.
 */
export function safeParseJson<T = unknown>(text: string): T {
  const parsed = JSON.parse(text, (key, value) =>
    isPollutionKey(key) ? undefined : value
  ) as T;
  // The reviver drops the keys it is called for, but a reviver is not invoked
  // for a key whose value is `undefined` in some engines' edge cases, so the
  // structural sweep runs as well. Belt and braces, both cheap.
  return sanitizeDeep(parsed).value;
}

/**
 * Deep-merges `sources` into `target`, skipping pollution keys at every level.
 *
 * Semantics: plain objects are merged recursively, everything else (arrays,
 * dates, primitives) replaces the previous value. Keys are written with
 * `Object.defineProperty` so a setter inherited from a prototype can never be
 * triggered by a merge.
 *
 * This is the sanctioned replacement for `Object.assign(existing, untrusted)`
 * and for hand-rolled `for (const k in src) dst[k] = src[k]` loops.
 */
export function safeMerge<T extends Record<string, unknown>>(
  target: T,
  ...sources: Array<Record<string, unknown> | null | undefined>
): T {
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    mergeInto(target as Record<string, unknown>, source, 0);
  }
  return target;
}

function mergeInto(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth: number
): void {
  if (depth > MAX_DEPTH) return;

  for (const key of Object.getOwnPropertyNames(source)) {
    if (isPollutionKey(key)) continue;

    const incoming = (source as Record<string, unknown>)[key];
    const existing = Object.prototype.hasOwnProperty.call(target, key)
      ? target[key]
      : undefined;

    if (isPlainContainer(incoming) && isPlainContainer(existing)) {
      mergeInto(existing, incoming, depth + 1);
      continue;
    }

    defineOwn(target, key, isPlainContainer(incoming) ? cloneSanitized(incoming, depth + 1) : incoming);
  }
}

function cloneSanitized(source: Record<string, unknown>, depth: number): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  if (depth > MAX_DEPTH) return clone;
  for (const key of Object.getOwnPropertyNames(source)) {
    if (isPollutionKey(key)) continue;
    const value = source[key];
    defineOwn(clone, key, isPlainContainer(value) ? cloneSanitized(value, depth + 1) : value);
  }
  return clone;
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Shallow {@link safeMerge}: copies only `source`'s own top-level keys, skipping
 * pollution keys. The drop-in replacement for `Object.assign(target, source)`
 * when `target` is not a fresh literal.
 */
export function safeAssign<T extends Record<string, unknown>>(
  target: T,
  ...sources: Array<Record<string, unknown> | null | undefined>
): T {
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    for (const key of Object.getOwnPropertyNames(source)) {
      if (isPollutionKey(key)) continue;
      defineOwn(target as Record<string, unknown>, key, source[key]);
    }
  }
  return target;
}

/**
 * A prototype-less dictionary. Lookups cannot fall through to
 * `Object.prototype`, so `map["toString"]` is `undefined` rather than a
 * function — the right shape for a cache or lookup table keyed by user input.
 */
export function createSafeRecord<V = unknown>(
  entries?: Record<string, V>
): Record<string, V> {
  const record = Object.create(null) as Record<string, V>;
  if (entries) {
    for (const key of Object.getOwnPropertyNames(entries)) {
      if (isPollutionKey(key)) continue;
      record[key] = entries[key];
    }
  }
  return record;
}

/**
 * Prototypes frozen by {@link freezeCriticalPrototypes}.
 *
 * `Function.prototype` is deliberately absent: instrumentation libraries
 * (OpenTelemetry, Sentry) legitimately patch function internals at require
 * time, and sealing it breaks them. The listed prototypes are the ones a
 * pollution payload actually targets and that nothing in this service writes
 * to after boot.
 */
export const CRITICAL_PROTOTYPES: ReadonlyArray<{ name: string; proto: object }> = [
  { name: "Object.prototype", proto: Object.prototype },
  { name: "Array.prototype", proto: Array.prototype },
  { name: "String.prototype", proto: String.prototype },
  { name: "Number.prototype", proto: Number.prototype },
  { name: "Boolean.prototype", proto: Boolean.prototype },
  { name: "Map.prototype", proto: Map.prototype },
  { name: "Set.prototype", proto: Set.prototype },
];

/**
 * Freezes the prototypes listed in {@link CRITICAL_PROTOTYPES}.
 *
 * Call once, at startup, *after* every module has been imported — freezing
 * before a library finishes patching its own prototypes would break it. Set
 * `PROTOTYPE_FREEZE=off` to skip (useful when bisecting a third-party
 * incompatibility); the guards in layers 1–2 stay active either way.
 *
 * @param targets Override for tests.
 * @returns The names actually frozen by this call.
 */
export function freezeCriticalPrototypes(
  targets: ReadonlyArray<{ name: string; proto: object }> = CRITICAL_PROTOTYPES
): string[] {
  if ((process.env.PROTOTYPE_FREEZE ?? "").toLowerCase() === "off") return [];

  const frozen: string[] = [];
  for (const target of targets) {
    // Reading `target.proto` inside the try as well: a host object can throw
    // on property access, and a failure to seal must never fail boot.
    try {
      const { name, proto } = target;
      Object.freeze(proto);
      if (Object.isFrozen(proto)) frozen.push(name);
    } catch {
      // A host that refuses to seal a builtin is not a reason to fail boot.
    }
  }
  return frozen;
}
