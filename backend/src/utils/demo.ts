// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/** Demo / sandbox mode toggle.
 *  When enabled, certain API routes skip real contract interactions and
 *  return mock data. Useful for frontend development and integration testing
 *  without a live Stellar network. */

export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "true";
}

export function requireDemo(req: unknown, res: any, next: () => void) {
  if (!isDemoMode()) {
    return res.status(403).json({ error: "Demo mode is not enabled" });
  }
  next();
}
