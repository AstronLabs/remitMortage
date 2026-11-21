// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { formatNumber, resolveLocaleTag } from "./formatCurrency";
import type { Locale } from "@/i18n/locales";

/**
 * Result of parsing a user-entered currency amount.
 *
 * Failure is modelled explicitly rather than returned as `NaN`: an amount that
 * can't be understood for the active locale has to be surfaced as invalid so
 * the caller rejects it, instead of being silently coerced. This is the bug
 * `parseFloat` causes — `parseFloat("1,234.56")` yields `1` and
 * `parseFloat("1.234,56")` yields `1.234` for a comma-decimal locale.
 */
export type LocaleAmountParseResult =
  | { ok: true; value: number }
  | { ok: false; reason: "empty" | "invalid" };

/** ISO codes a user might paste alongside (or instead of) a currency symbol. */
const CURRENCY_CODE_PATTERN = /\b(?:USD|USDC|EUR|GBP|JPY|NGN|CAD|AUD|CHF)\b/gi;

/**
 * Whitespace is a grouping separator in several locales (fr-FR uses a narrow
 * no-break space) and is never significant to the value, so every unicode
 * space variant is stripped before parsing.
 */
const WHITESPACE_PATTERN = /[\s\u00a0\u202f\u2009\u2007]/g;

function escapeRegExp(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The locale's actual decimal and grouping separators, straight from Intl. */
function separatorsFor(locale: Locale): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(resolveLocaleTag(locale)).formatToParts(9876543.21);
  const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
  const group = parts.find((part) => part.type === "group")?.value ?? "";
  return { decimal, group };
}

/**
 * Parses a user-entered amount using the active locale's separators.
 *
 * Accepts a leading currency symbol or code and surrounding/grouping
 * whitespace, so a value copied from a statement (e.g. "1 234,56 €") parses;
 * returns `ok: false` for anything it cannot represent exactly, so the caller
 * can reject bad input rather than round or truncate it.
 */
export function parseLocaleAmount(input: string, locale: Locale): LocaleAmountParseResult {
  const { decimal, group } = separatorsFor(locale);

  let text = (input ?? "").trim();
  if (!text) return { ok: false, reason: "empty" };

  text = text
    .replace(/\p{Sc}/gu, "") // currency symbols ($, €, £, ₦, …)
    .replace(CURRENCY_CODE_PATTERN, "") // currency codes (USD, EUR, …)
    .replace(WHITESPACE_PATTERN, ""); // grouping whitespace / stray spaces
  if (!text) return { ok: false, reason: "empty" };

  // Only digits and the locale's own separators are meaningful; anything else
  // (letters, a foreign decimal point, repeated punctuation) is invalid.
  const hasDistinctGroup = group !== "" && group !== decimal;
  const disallowed = new RegExp(
    hasDistinctGroup
      ? `[^0-9${escapeRegExp(decimal)}${escapeRegExp(group)}]`
      : `[^0-9${escapeRegExp(decimal)}]`
  );
  if (disallowed.test(text)) return { ok: false, reason: "invalid" };

  // At most one decimal separator; grouping is only valid in the integer part.
  const segments = decimal ? text.split(decimal) : [text];
  if (segments.length > 2) return { ok: false, reason: "invalid" };

  const [integerRaw, fractionRaw] = segments;
  const integerPart = hasDistinctGroup ? integerRaw.split(group).join("") : integerRaw;
  if (!/^\d+$/.test(integerPart)) return { ok: false, reason: "invalid" };
  if (fractionRaw !== undefined && !/^\d+$/.test(fractionRaw)) {
    return { ok: false, reason: "invalid" };
  }

  const normalized = fractionRaw !== undefined ? `${integerPart}.${fractionRaw}` : integerPart;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return { ok: false, reason: "invalid" };

  return { ok: true, value };
}

/**
 * Formats an amount for display inside an input using the locale's grouping
 * and decimal separators, preserving the given number of fraction digits so
 * the display never rounds a value the user is still editing.
 */
export function formatLocaleAmount(value: number, locale: Locale, fractionDigits = 2): string {
  const digits = Math.min(Math.max(Math.trunc(fractionDigits), 0), 20);
  return formatNumber(value, locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Number of fraction digits present in a raw amount string (0 when none). */
export function fractionDigitsOf(input: string, locale: Locale): number {
  const { decimal } = separatorsFor(locale);
  if (!decimal) return 0;
  const cleaned = (input ?? "").replace(CURRENCY_CODE_PATTERN, "");
  const index = cleaned.lastIndexOf(decimal);
  if (index === -1) return 0;
  const digits = cleaned.slice(index + decimal.length).replace(/[^0-9]/g, "");
  return Math.min(digits.length, 20);
}
