// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { queueService } from "../services/queueService.js";

/**
 * Promotes low-lane BullMQ jobs that have waited past the fair-share threshold
 * so a continuous stream of high-priority work cannot starve them (issue #985).
 */
export async function runQueueFairnessRebalanceJob(
  now: Date = new Date()
): Promise<{ promoted: number }> {
  return queueService.rebalanceAgedJobs(now.getTime());
}
