// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Browser-side prototype-pollution guards (issue #885).
 *
 * The browser half of `backend/src/utils/safeObject.ts`, kept deliberately
 * small: the frontend never merges a request body, but it does parse JSON from
 * the API, from `localStorage` and from `postMessage`, and it folds those
 * objects into client state. The same three keys are the same hazard there —
 * a polluted `Object.prototype` in a long-lived SPA tab changes every object
 * the page creates afterwards.
 *
 * `scripts/check-unsafe-merge.mjs` fails CI on a hand-rolled merge in
 * `frontend/src`, so these helpers are the sanctioned path.
 */

/** Keys that can reach a shared prototype and are never legitimate input. */
export const POLLUTION_KEYS = ["__proto__", "constructor", "prototype"] as const;

const POLLUTION_KEY_SET: ReadonlySet<string> = new Set<string>(POLLUTION_KEYS);

const MAX_DEPTH = 32;

/** True when `key` is one of the three keys that can mutate a prototype. */
export function isPollutionKey(key: string): boolean {
  return POLLUTION_KEY_SET.has(key);
}

function isPlainContainer(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Removes every `__proto__` / `constructor` / `prototype` own key from `value`,
 * recursively and in place. Returns the same reference for convenience.
 */
export function sanitizeDeep<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return value;

  if (Array.isArray(value)) {
    for (const entry of value) sanitizeDeep(entry, depth + 1);
    return value;
  }

  if (!isPlainContainer(value)) return value;

  for (const key of Object.getOwnPropertyNames(value)) {
    if (isPollutionKey(key)) {
      delete (value as Record<string, unknown>)[key];
      continue;
    }
    sanitizeDeep((value as Record<string, unknown>)[key], depth + 1);
  }
  return value;
}

/**
 * `JSON.parse` that cannot hand back a pollution key. Use it for anything that
 * did not originate in this tab: API responses, `localStorage`, `postMessage`.
 *
 * @throws SyntaxError when `text` is not valid JSON — same as `JSON.parse`.
 */
export function safeParseJson<T = unknown>(text: string): T {
  const parsed = JSON.parse(text, (key, value) =>
    isPollutionKey(key) ? undefined : value
  ) as T;
  return sanitizeDeep(parsed);
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
 * Shallow merge that skips pollution keys — the drop-in replacement for
 * `Object.assign(target, source)` when `target` is not a fresh literal.
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

/** Deep merge that skips pollution keys at every level. */
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

    const incoming = source[key];
    const existing = Object.prototype.hasOwnProperty.call(target, key)
      ? target[key]
      : undefined;

    if (isPlainContainer(incoming) && isPlainContainer(existing)) {
      mergeInto(existing, incoming, depth + 1);
      continue;
    }

    defineOwn(target, key, incoming);
  }
}
