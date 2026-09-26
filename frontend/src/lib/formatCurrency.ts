// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { Locale } from "@/i18n/locales";

/**
 * BCP-47 tags for each supported locale. Kept as an explicit map (rather than
 * passing the locale straight to Intl) so an unsupported locale fails loudly
 * instead of silently falling back to the runtime's default (often en-US).
 */
const LOCALE_TAGS: Record<Locale, string> = {
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
};

/** Default currency to render when the caller doesn't specify one. */
const DEFAULT_CURRENCY: Record<Locale, string> = {
  en: "USD",
  es: "EUR",
  fr: "EUR",
};

function resolveTag(locale: Locale): string {
  const tag = LOCALE_TAGS[locale];
  if (!tag) {
    throw new Error(`Unsupported locale for number formatting: ${locale}`);
  }
  return tag;
}

export function formatCurrency(
  amount: number,
  locale: Locale,
  currency: string = DEFAULT_CURRENCY[locale]
): string {
  return new Intl.NumberFormat(resolveTag(locale), {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
  }).format(amount);
}

export function formatNumber(
  value: number,
  locale: Locale,
  options?: Intl.NumberFormatOptions
): string {
  return new Intl.NumberFormat(resolveTag(locale), options).format(value);
}
