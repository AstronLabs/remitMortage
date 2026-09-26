// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/** Centralized Redis cache key builders.
 *
 *  IMPORTANT: The exact string format returned by each function is part of the
 *  runtime contract between this module and the data in Redis.  If a format
 *  is changed, existing cached entries under the old format become orphaned
 *  and will never be evicted unless a deployment runbook step explicitly
 *  flushes the affected keys.  Always add a cache flush step to the deploy
 *  runbook when modifying a key format. */

export function analyticsKey(route: string): string {
  return `analytics:${route}`;
}

export function remittanceKey(walletAddress: string): string {
  return `remittance:${walletAddress}`;
}

export function verificationKey(borrowerAddress: string): string {
  return `verification:${borrowerAddress}`;
}

export function idempotencyKey(requestKey: string): string {
  return `idempotency:${requestKey}`;
}
