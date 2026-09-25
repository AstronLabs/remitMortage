// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import en from "./locales/en.js";
import es from "./locales/es.js";
import fr from "./locales/fr.js";

export type Locale = "en" | "es" | "fr";

export const SUPPORTED_LOCALES: readonly Locale[] = ["en", "es", "fr"];

const translations: Record<Locale, Record<string, string>> = { en, es, fr };

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const dict = translations[locale] ?? translations.en;
  let value = dict[key] ?? translations.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}

export function isValidLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
