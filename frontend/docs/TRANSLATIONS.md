# Adding and Maintaining Translation Keys

The frontend uses [`next-intl`](https://next-intl.dev/) with locale catalogs stored under `src/i18n/messages/`:

- `src/i18n/messages/en.json` (default / source-of-truth locale)
- `src/i18n/messages/es.json` (Spanish)
- `src/i18n/messages/fr.json` (French)

## How to Add a Translation Key

1. **Add the key to `src/i18n/messages/en.json`** under the relevant namespace (for example `nav`, `footer`, `landing`, `verify`, or `dashboard`).
2. **Add the translated string under the exact same namespace and key path** in every non-default locale file (`es.json` and `fr.json`).
3. **Reference the key in your component** via `useTranslations("<namespace>")`:
   ```tsx
   const t = useTranslations("dashboard");
   return <button>{t("depositUsdc")}</button>;
   ```
4. **Run the translation check** before committing:
   ```bash
   node ./scripts/check-translations.mjs
   ```

## Automated Build & Test Enforcement

Translation consistency runs automatically as part of the frontend Jest test suite (`npm test`). The check fails with a non-zero exit code if:

- Any key present in `en.json` is missing in `es.json` or `fr.json`.
- Any locale contains an orphaned key that does not exist in `en.json`.
- Any translation value is empty or whitespace-only.
- Source code calls `t("<key>")` for a key missing from `en.json`.
