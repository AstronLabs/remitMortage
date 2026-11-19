// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { runReverificationSweep } from "../services/investorReverification.js";
import logger from "../utils/logger.js";

/**
 * Daily sweep (issue #725): reminds accredited investors whose re-verification
 * deadline is approaching, and follows up with those who missed it.
 *
 * Exported for direct invocation (tests / admin trigger).
 */
export async function runInvestorReverificationJob(): Promise<{ reminded: number; followedUp: number }> {
  logger.info("[reverification] Starting accredited investor re-verification sweep");
  const result = await runReverificationSweep();
  logger.info("[reverification] Sweep complete", result);
  return result;
}
