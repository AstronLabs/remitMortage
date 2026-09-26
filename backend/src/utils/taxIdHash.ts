// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { createHmac } from "crypto";
import { loadConfig } from "../config.js";

/**
 * Strips formatting so "123-45-6789", "123 45 6789" and "123456789" compare
 * equal. Returns null when nothing identifying is left.
 */
export function normalizeTaxId(raw: string): string | null {
  const normalized = String(raw).replace(/[^0-9a-z]/gi, "").toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Keyed HMAC of a normalized tax ID, used to find duplicate applicants
 * without storing the plaintext. Null when the input normalizes to nothing.
 */
export function hashTaxId(raw: string): string | null {
  const normalized = normalizeTaxId(raw);
  if (!normalized) return null;
  return createHmac("sha256", loadConfig().taxIdHashSecret).update(normalized).digest("hex");
}
