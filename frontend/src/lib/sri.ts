// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Subresource Integrity (SRI) helper
 *
 * Centralizes pinned hashes for any third-party script/style loaded via CDN.
 * Every external <script src="https://..."> or <link href="https://..." rel="stylesheet">
 * MUST use `sriProps(url)` so `integrity` + `crossorigin="anonymous"` are enforced.
 *
 * Hash generation:
 *   curl -s https://cdn.example.com/lib@1.2.3/lib.min.js | \
 *     openssl dgst -sha384 -binary | openssl base64 -A
 *   # then prefix with "sha384-"
 *   # Or: node scripts/sri-hash.mjs https://cdn.example.com/lib.js
 *
 * Fail-closed: throws if URL is not in manifest, so new CDN loads cannot
 * silently bypass SRI. Add the hash to `SRI_MANIFEST` when the version is pinned.
 *
 * See: https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
 */

// Pinned SRI hashes. Keys must be exact URL strings used in src/href.
// Use exact versioned URLs, never `latest` or moving tags.
export const SRI_MANIFEST = {
  // Example (do not use without replacing with real hash):
  // "https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js":
  //   "sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC4Fq5g==",
} as const satisfies Record<string, string>;

export type SriUrl = keyof typeof SRI_MANIFEST;

const INTEGRITY_RE = /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/;

export function isValidIntegrity(value: string): boolean {
  return INTEGRITY_RE.test(value.trim());
}

/**
 * Returns props to spread onto <script> or <link> for SRI.
 * Throws if url is not pinned — fail-closed per fix.md #500.
 */
export function sriProps(url: string): { integrity: string; crossOrigin: "anonymous" } {
  const integrity = (SRI_MANIFEST as Record<string, string>)[url];
  if (!integrity) {
    throw new Error(
      `[SRI] Missing integrity hash for ${url}. ` +
        `Generate with: openssl dgst -sha384 -binary | openssl base64 -A ` +
        `or node frontend/scripts/sri-hash.mjs ${url} and add to SRI_MANIFEST in src/lib/sri.ts`
    );
  }
  if (!isValidIntegrity(integrity)) {
    throw new Error(`[SRI] Invalid integrity format for ${url}: ${integrity}`);
  }
  return { integrity, crossOrigin: "anonymous" };
}

/**
 * Validate an integrity string format without throwing.
 * Useful for CI checker and tests.
 */
export function assertValidIntegrity(url: string, integrity: string): void {
  if (!isValidIntegrity(integrity)) {
    throw new Error(`[SRI] Invalid integrity for ${url}: ${integrity} (expected sha256|384|512-base64)`);
  }
}

/**
 * Build an SRI hash from raw bytes (for tooling/tests).
 * e.g. buildIntegrity(await fetch(url).then(r=>r.arrayBuffer()), 'sha384')
 */
export async function buildIntegrity(
  data: ArrayBuffer | Uint8Array | string,
  algorithm: "sha256" | "sha384" | "sha512" = "sha384"
): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data as ArrayBuffer);
  // Prefer Web Crypto if available, fallback to Node crypto
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const algo = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" }[algorithm];
    const digest = await globalThis.crypto.subtle.digest(algo, bytes as unknown as BufferSource);
    const b64 = Buffer.from(digest).toString("base64");
    return `${algorithm}-${b64}`;
  } else {
    const { createHash } = await import("node:crypto");
    const nodeAlgo = algorithm.replace("-", "");
    const hash = createHash(nodeAlgo).update(Buffer.from(bytes)).digest("base64");
    return `${algorithm}-${hash}`;
  }
}
