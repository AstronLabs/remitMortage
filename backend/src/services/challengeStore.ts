// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { randomUUID } from "crypto";

/** In-memory store for pending wallet-ownership challenges. */

interface ChallengeEntry {
  challenge: string;
  expiresAt: number; // epoch ms
  used: boolean;
}

// walletAddress → ChallengeEntry
const store = new Map<string, ChallengeEntry>();

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export function createChallenge(walletAddress: string): string {
  const nonce = randomUUID().replace(/-/g, "");
  const timestamp = Date.now();
  const challenge = `RemitMortgage-verify-${nonce}-${timestamp}`;
  store.set(walletAddress, { challenge, expiresAt: timestamp + TTL_MS, used: false });
  return challenge;
}

export type ConsumeResult =
  | { ok: true; challenge: string }
  | { ok: false; reason: "not_found" | "expired" | "already_used" };

export function consumeChallenge(walletAddress: string, challenge: string): ConsumeResult {
  const entry = store.get(walletAddress);
  if (!entry || entry.challenge !== challenge) return { ok: false, reason: "not_found" };
  if (entry.used) return { ok: false, reason: "already_used" };
  if (Date.now() > entry.expiresAt) return { ok: false, reason: "expired" };
  entry.used = true;
  return { ok: true, challenge: entry.challenge };
}

/** Exposed for testing only. */
export function _setEntry(walletAddress: string, entry: ChallengeEntry): void {
  store.set(walletAddress, entry);
}

export function _clearStore(): void {
  store.clear();
}
