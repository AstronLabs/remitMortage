// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { runSanctionsSweep, type SanctionsSweepResult } from "../services/sanctionsScreening.js";
import logger from "../utils/logger.js";

/**
 * Hourly sweep (issue #922): re-screens parties whose last screening failed,
 * predates the provider's current sanctions-list version, or is older than the
 * re-screen interval. Running hourly means a list update is picked up within
 * the hour.
 *
 * Exported for direct invocation (tests / admin trigger).
 */
export async function runSanctionsScreeningJob(): Promise<SanctionsSweepResult> {
  logger.info("[sanctions] Starting sanctions re-screening sweep");
  const result = await runSanctionsSweep();
  logger.info("[sanctions] Sweep complete", result);
  return result;
}
