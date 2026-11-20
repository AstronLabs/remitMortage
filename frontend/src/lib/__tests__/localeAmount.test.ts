// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { fractionDigitsOf, formatLocaleAmount, parseLocaleAmount } from "../localeAmount";
import { locales, type Locale } from "@/i18n/locales";

/** Grouped value as a user of each locale would type or paste it. */
const GROUPED_BY_LOCALE: Record<Locale, string> = {
  en: "1,234.56",
  es: "1.234,56",
  fr: "1 234,56",
};

const SEPARATORS: Record<Locale, { decimal: string; grouping: RegExp }> = {
  en: { decimal: ".", grouping: /,/ },
  es: { decimal: ",", grouping: /\./ },
  fr: { decimal: ",", grouping: /\s/ },
};

describe("parseLocaleAmount", () => {
  it.each(locales)("parses the locale's own grouped format for '%s'", (locale) => {
    expect(parseLocaleAmount(GROUPED_BY_LOCALE[locale], locale)).toEqual({
      ok: true,
      value: 1234.56,
    });
  });

  it.each(locales)("parses a bare decimal value for '%s'", (locale) => {
    const raw = `0${SEPARATORS[locale].decimal}5`;
    expect(parseLocaleAmount(raw, locale)).toEqual({ ok: true, value: 0.5 });
  });

  it("parses a formatted amount pasted from a statement", () => {
    expect(parseLocaleAmount("1 234,56 €", "fr")).toEqual({ ok: true, value: 1234.56 });
    expect(parseLocaleAmount("€ 1.234,56", "es")).toEqual({ ok: true, value: 1234.56 });
    expect(parseLocaleAmount("$1,234.56", "en")).toEqual({ ok: true, value: 1234.56 });
    expect(parseLocaleAmount("USD 1,234.56", "en")).toEqual({ ok: true, value: 1234.56 });
    expect(parseLocaleAmount("USDC 1 234,56", "fr")).toEqual({ ok: true, value: 1234.56 });
  });

  it("treats empty or whitespace-only input as empty rather than zero", () => {
    expect(parseLocaleAmount("", "en")).toEqual({ ok: false, reason: "empty" });
    expect(parseLocaleAmount("   ", "es")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a value using a foreign decimal separator instead of silently coercing it", () => {
    // These are exactly the strings `parseFloat` mangles into 1 and 1.234.
    expect(parseFloat("1,234.56")).toBe(1);
    expect(parseLocaleAmount("1,234.56", "es")).toEqual({ ok: false, reason: "invalid" });

    expect(parseFloat("1.234,56")).toBe(1.234);
    expect(parseLocaleAmount("1.234,56", "en")).toEqual({ ok: false, reason: "invalid" });
  });

  it.each(locales)("rejects unparseable text for '%s'", (locale) => {
    expect(parseLocaleAmount("not a number", locale)).toEqual({ ok: false, reason: "invalid" });
    expect(parseLocaleAmount("12.34.56", locale)).toEqual({ ok: false, reason: "invalid" });
    expect(parseLocaleAmount("1..2", locale)).toEqual({ ok: false, reason: "invalid" });
  });

  it("throws for an unsupported locale rather than defaulting", () => {
    expect(() => parseLocaleAmount("1,234.56", "de" as Locale)).toThrow();
  });
});

describe("formatLocaleAmount", () => {
  it.each(locales)("uses the locale's decimal separator for '%s'", (locale) => {
    expect(formatLocaleAmount(42.07, locale)).toContain(SEPARATORS[locale].decimal);
  });

  it.each(locales)("uses the locale's grouping separator for '%s'", (locale) => {
    expect(formatLocaleAmount(1234.56, locale)).toMatch(SEPARATORS[locale].grouping);
  });

  it.each(locales)("round-trips through the parser for '%s'", (locale) => {
    const rendered = formatLocaleAmount(1234.5, locale);
    expect(parseLocaleAmount(rendered, locale)).toEqual({ ok: true, value: 1234.5 });
  });

  it("honours the requested fraction-digit count", () => {
    expect(formatLocaleAmount(7, "en", 0)).toBe("7");
    expect(formatLocaleAmount(7, "en", 2)).toBe("7.00");
  });
});

describe("fractionDigitsOf", () => {
  it.each(locales)("counts the fraction digits in a '%s' amount", (locale) => {
    expect(fractionDigitsOf(GROUPED_BY_LOCALE[locale], locale)).toBe(2);
  });

  it("returns 0 when there is no decimal separator", () => {
    expect(fractionDigitsOf("1,234", "en")).toBe(0);
  });
});
