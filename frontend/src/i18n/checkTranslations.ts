// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "node:fs";
import path from "node:path";

const DEFAULT_LOCALE = "en";

export interface TranslationReport {
  ok: boolean;
  locales: string[];
  totalKeys: number;
  missingByLocale: Record<string, string[]>;
  extraByLocale: Record<string, string[]>;
  emptyByLocale: Record<string, string[]>;
  missingFromDefault: string[];
  unusedInCode: string[];
  errors: string[];
}

export function flattenMessages(obj: unknown, prefix = ""): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return result;
  }
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [nestedKey, nestedVal] of flattenMessages(value, fullKey)) {
        result.set(nestedKey, nestedVal);
      }
    } else {
      result.set(fullKey, value);
    }
  }
  return result;
}

function collectSourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === ".next") {
        continue;
      }
      files.push(...collectSourceFiles(fullPath));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx") &&
      !entry.name.endsWith(".stories.tsx")
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

export function extractCodeTranslationKeys(srcDir?: string): Set<string> {
  if (!srcDir || !fs.existsSync(srcDir)) return new Set();
  const usedKeys = new Set<string>();
  const files = collectSourceFiles(srcDir);

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const nsBindings = new Map<string, string>();
    const hookRegex =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\(\s*["']([^"']+)["']\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = hookRegex.exec(content)) !== null) {
      nsBindings.set(match[1], match[2]);
    }

    for (const [varName, namespace] of nsBindings.entries()) {
      const callRegex = new RegExp(`\\b${varName}\\(\\s*["']([A-Za-z0-9_.-]+)["']`, "g");
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(content)) !== null) {
        const subKey = callMatch[1];
        usedKeys.add(namespace ? `${namespace}.${subKey}` : subKey);
      }
    }
  }

  return usedKeys;
}

export function checkTranslations({
  messagesDir,
  srcDir,
  defaultLocale = DEFAULT_LOCALE,
}: {
  messagesDir?: string;
  srcDir?: string;
  defaultLocale?: string;
} = {}): TranslationReport {
  const resolvedMessagesDir = messagesDir ?? path.resolve(__dirname, "messages");
  const resolvedSrcDir = srcDir ?? path.resolve(__dirname, "..");

  const defaultFile = path.join(resolvedMessagesDir, `${defaultLocale}.json`);
  if (!fs.existsSync(defaultFile)) {
    throw new Error(`Default locale file not found: ${defaultFile}`);
  }

  const localeFiles = fs
    .readdirSync(resolvedMessagesDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const localeMaps = new Map<string, Map<string, unknown>>();
  for (const file of localeFiles) {
    const locale = path.basename(file, ".json");
    const raw = JSON.parse(fs.readFileSync(path.join(resolvedMessagesDir, file), "utf8"));
    localeMaps.set(locale, flattenMessages(raw));
  }

  const defaultMap = localeMaps.get(defaultLocale)!;
  const defaultKeys = new Set(defaultMap.keys());

  const missingByLocale: Record<string, string[]> = {};
  const extraByLocale: Record<string, string[]> = {};
  const emptyByLocale: Record<string, string[]> = {};
  const errors: string[] = [];

  for (const [locale, map] of localeMaps.entries()) {
    for (const [k, v] of map.entries()) {
      if (typeof v !== "string" || v.trim() === "") {
        emptyByLocale[locale] = emptyByLocale[locale] || [];
        emptyByLocale[locale].push(k);
        errors.push(`Empty translation value for key "${k}" in locale "${locale}".`);
      }
    }

    if (locale === defaultLocale) continue;

    const missing: string[] = [];
    for (const key of defaultKeys) {
      if (!map.has(key)) {
        missing.push(key);
        errors.push(`Missing key "${key}" in locale "${locale}" (defined in "${defaultLocale}").`);
      }
    }
    if (missing.length > 0) {
      missingByLocale[locale] = missing;
    }

    const extra: string[] = [];
    for (const key of map.keys()) {
      if (!defaultKeys.has(key)) {
        extra.push(key);
        errors.push(
          `Orphaned key "${key}" in locale "${locale}" (not present in default locale "${defaultLocale}").`
        );
      }
    }
    if (extra.length > 0) {
      extraByLocale[locale] = extra;
    }
  }

  const usedInCode = extractCodeTranslationKeys(resolvedSrcDir);
  const missingFromDefault: string[] = [];
  for (const key of usedInCode) {
    if (!defaultKeys.has(key)) {
      missingFromDefault.push(key);
      errors.push(
        `Key "${key}" is referenced in source code but missing from default locale "${defaultLocale}".`
      );
    }
  }

  const unusedInCode: string[] = [];
  for (const key of defaultKeys) {
    if (usedInCode.size > 0 && !usedInCode.has(key)) {
      unusedInCode.push(key);
    }
  }

  return {
    ok: errors.length === 0,
    locales: Array.from(localeMaps.keys()),
    totalKeys: defaultKeys.size,
    missingByLocale,
    extraByLocale,
    emptyByLocale,
    missingFromDefault,
    unusedInCode,
    errors,
  };
}
