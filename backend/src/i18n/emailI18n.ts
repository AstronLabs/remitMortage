/**
 * Locale-aware email translation helper.
 *
 * Locale selection / fallback chain:
 *   1. Use requestedLocale when it is in SUPPORTED_LOCALES.
 *   2. Fall back to "en" for missing / unsupported locales.
 *   3. Fall back to "en" for any individual missing key within a locale.
 *   4. Never return a raw translation key — "en" is always fully populated.
 */

import {
  SUPPORTED_LOCALES,
  SupportedLocale,
  emailTranslations,
  EmailTranslationCatalogue,
} from "./emailTranslations.js";

export { SUPPORTED_LOCALES };
export type { SupportedLocale };

/** Normalize an arbitrary locale string into a SupportedLocale or "en". */
export function resolveLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return "en";
  // Exact match first (e.g. "en", "es", "pt", "fr", "zh")
  const exact = raw.toLowerCase().trim();
  if ((SUPPORTED_LOCALES as readonly string[]).includes(exact)) {
    return exact as SupportedLocale;
  }
  // Language-tag prefix match (e.g. "pt-BR" → "pt", "zh-TW" → "zh")
  const prefix = exact.split("-")[0];
  if ((SUPPORTED_LOCALES as readonly string[]).includes(prefix)) {
    return prefix as SupportedLocale;
  }
  return "en";
}

/**
 * Returns a translation function for the given locale.
 * The returned `t(key, vars?)` function:
 *   - Looks up the key in the resolved locale catalogue.
 *   - Falls back to the "en" catalogue if the key is missing.
 *   - Interpolates `{{varName}}` placeholders with values from `vars`.
 *   - Never returns a raw key string.
 */
export function getEmailTranslator(rawLocale: string | null | undefined) {
  const locale = resolveLocale(rawLocale);
  const catalogue: EmailTranslationCatalogue = emailTranslations[locale];
  const fallback: EmailTranslationCatalogue = emailTranslations["en"];

  return function t(
    key: keyof EmailTranslationCatalogue,
    vars?: Record<string, string | number>
  ): string {
    // Prefer the resolved locale; fall back to English for missing keys.
    const raw: string =
      catalogue[key] !== undefined ? catalogue[key] : fallback[key];

    if (!vars) return raw;

    // Interpolate {{varName}} placeholders
    return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      const val = vars[name];
      return val !== undefined ? String(val) : `{{${name}}}`;
    });
  };
}

/** Returns the resolved locale name — useful for logging. */
export function getResolvedLocale(raw: string | null | undefined): SupportedLocale {
  return resolveLocale(raw);
}
