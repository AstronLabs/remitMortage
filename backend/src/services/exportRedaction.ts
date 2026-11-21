// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * PII redaction levels for admin exports (issue #1104).
 *
 * An export's audience decides how much personal data it carries:
 *  - `full`       — every field as stored, for a compliance reviewer who
 *                   genuinely needs the detail.
 *  - `partial`    — one row per event, but wallet addresses masked, IPs
 *                   truncated to their network, and PII-looking metadata
 *                   keys replaced with a redaction marker.
 *  - `aggregate`  — no per-event rows at all, only counts per action, for
 *                   analytics audiences.
 *
 * When the requesting admin doesn't choose, the most redacted level applies.
 */

export const EXPORT_REDACTION_LEVELS = ["full", "partial", "aggregate"] as const;
export type ExportRedactionLevel = (typeof EXPORT_REDACTION_LEVELS)[number];

/** Least to most redacted; the default is always the last entry. */
export const DEFAULT_EXPORT_REDACTION_LEVEL: ExportRedactionLevel =
  EXPORT_REDACTION_LEVELS[EXPORT_REDACTION_LEVELS.length - 1];

export const REDACTED = "[REDACTED]";

/**
 * Metadata keys treated as personal data under `partial` redaction. Keys are
 * split into camelCase / snake_case words and matched word-by-word, so `ip`
 * catches `ipAddress` and `client_ip` but not `description`.
 */
const PII_KEY_WORDS = new Set([
  "email",
  "phone",
  "name",
  "address",
  "ip",
  "ssn",
  "tin",
  "dob",
  "birth",
  "passport",
  "income",
  "salary",
  "iban",
  "wallet",
]);
/** Whole-key matches for PII whose individual words are too generic on their own. */
const PII_COMPOUND_KEYS = new Set(["taxid", "useragent", "accountnumber", "routingnumber", "dateofbirth"]);

export function isExportRedactionLevel(value: unknown): value is ExportRedactionLevel {
  return typeof value === "string" && (EXPORT_REDACTION_LEVELS as readonly string[]).includes(value);
}

/**
 * Resolves a requested level: undefined/null falls back to the default
 * (most redacted); anything else must be a known level or this returns null
 * so the caller can reject the request rather than silently guess.
 */
export function resolveExportRedactionLevel(requested: unknown): ExportRedactionLevel | null {
  if (requested === undefined || requested === null || requested === "") return DEFAULT_EXPORT_REDACTION_LEVEL;
  return isExportRedactionLevel(requested) ? requested : null;
}

/** Keeps the first and last four characters of an identifier, e.g. `GABC…WXYZ`. */
export function maskIdentifier(value: string | null): string | null {
  if (value === null) return null;
  if (value.length <= 8) return REDACTED;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/** Truncates an IPv4 address to its /24 network and an IPv6 address to its /48 prefix. */
export function truncateIp(ip: string | null): string | null {
  if (ip === null) return null;
  const v4 = ip.replace(/^::ffff:/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    return `${v4.split(".").slice(0, 3).join(".")}.0`;
  }
  if (ip.includes(":")) {
    return `${ip.split(":").slice(0, 3).join(":")}::`;
  }
  return REDACTED;
}

function isPiiKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w) => PII_KEY_WORDS.has(w)) || PII_COMPOUND_KEYS.has(words.join(""));
}

/** Recursively replaces the values of PII-looking keys with `[REDACTED]`. */
export function redactMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, isPiiKey(k) ? REDACTED : redactMetadata(v)])
    );
  }
  return value;
}
