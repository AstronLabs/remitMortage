// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { formatCurrency, formatNumber } from "../formatCurrency";
import { locales, type Locale } from "@/i18n/locales";

const AMOUNTS = {
  small: 0.5,
  fractional: 42.07,
  large: 1234567.89,
};

const CURRENCY_BY_LOCALE: Record<Locale, string> = {
  en: "USD",
  es: "EUR",
  fr: "EUR",
};

const SYMBOL_BY_CURRENCY: Record<string, string> = {
  USD: "\\$",
  EUR: "€",
};

/** decimal / grouping separator conventions per locale. */
const SEPARATORS: Record<Locale, { decimal: string; grouping: RegExp }> = {
  en: { decimal: ".", grouping: /,/ },
  es: { decimal: ",", grouping: /\./ },
  fr: { decimal: ",", grouping: /\s/ },
};

describe("formatCurrency", () => {
  it.each(locales)("renders every amount for locale '%s' without throwing", (locale) => {
    for (const amount of Object.values(AMOUNTS)) {
      expect(() => formatCurrency(amount, locale)).not.toThrow();
    }
  });

  it.each(locales)("uses the locale's decimal separator for '%s'", (locale) => {
    const { decimal } = SEPARATORS[locale];
    const result = formatCurrency(AMOUNTS.fractional, locale);
    // 42.07 always has fractional digits, so the decimal separator must appear.
    expect(result).toContain(decimal);
  });

  it.each(locales)("uses the locale's thousands grouping separator for '%s'", (locale) => {
    const { grouping } = SEPARATORS[locale];
    const result = formatCurrency(AMOUNTS.large, locale);
    expect(result).toMatch(grouping);
  });

  it.each(locales)("places the currency symbol per locale convention for '%s'", (locale) => {
    const currency = CURRENCY_BY_LOCALE[locale];
    const symbol = SYMBOL_BY_CURRENCY[currency];
    const result = formatCurrency(AMOUNTS.fractional, locale, currency);

    expect(result).toMatch(new RegExp(symbol));

    if (locale === "en") {
      // en-US: symbol prefixes the amount, e.g. "$42.07"
      expect(result).toMatch(new RegExp(`^${symbol}`));
    } else {
      // es-ES / fr-FR: symbol trails the amount, e.g. "42,07 €"
      expect(result).toMatch(new RegExp(`${symbol}$`));
    }
  });

  it.each(locales)("never silently falls back to a default format for '%s'", (locale) => {
    const currency = CURRENCY_BY_LOCALE[locale];
    const result = formatCurrency(AMOUNTS.large, locale, currency);
    const enUsResult = formatCurrency(AMOUNTS.large, "en", currency);

    if (locale !== "en") {
      // A locale-correct render must differ from the en-US rendering of the
      // same amount/currency — otherwise formatting silently fell back.
      expect(result).not.toBe(enUsResult);
    }
  });

  it("throws rather than silently defaulting for an unsupported locale", () => {
    expect(() => formatCurrency(AMOUNTS.large, "de" as Locale)).toThrow();
  });

  // RTL-locale number formatting (e.g. ar, he) is not yet covered because no
  // RTL locale is registered in `frontend/src/i18n/locales.ts` today. Extend
  // this suite with directional-mark assertions once RTL support lands.
});

describe("formatNumber", () => {
  it.each(locales)("uses the locale's separators for plain numbers in '%s'", (locale) => {
    const { grouping } = SEPARATORS[locale];
    const result = formatNumber(AMOUNTS.large, locale);
    expect(result).toMatch(grouping);
  });

  it("throws rather than silently defaulting for an unsupported locale", () => {
    expect(() => formatNumber(AMOUNTS.large, "de" as Locale)).toThrow();
  });
});
