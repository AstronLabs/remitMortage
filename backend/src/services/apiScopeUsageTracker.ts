// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Records which capabilities of a third-party integration our code actually
 * exercises, so the scheduled scope audit (`services/apiKeyScopeAudit.ts`)
 * can compare that against each credential's granted provider scope.
 *
 * Call sites (provider service files) call `recordApiCapabilityUsage`
 * fire-and-forget right after a real outbound call succeeds — never awaited
 * on the critical path, and never allowed to affect the call it's observing.
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";

export interface CapabilityUsageInfo {
  callCount: number;
  lastUsedAt: Date | null;
}

/**
 * Marks one successful use of `capability` against `integration`.
 *
 * Best-effort: a tracking failure is logged and swallowed, never thrown,
 * since losing a usage-audit data point is never a reason to fail (or even
 * slow down) the outbound call that just happened.
 */
export async function recordApiCapabilityUsage(
  integration: string,
  capability: string
): Promise<void> {
  try {
    await (prisma as any).apiCapabilityUsage.upsert({
      where: { integration_capability: { integration, capability } },
      update: { callCount: { increment: 1 }, lastUsedAt: new Date() },
      create: { integration, capability, callCount: 1, lastUsedAt: new Date() },
    });
  } catch (err) {
    logger.warn("[api-scope-audit] Failed to record capability usage", {
      integration,
      capability,
      err,
    });
  }
}

/**
 * Usage recorded so far for every capability of one integration.
 *
 * Returns an empty map (never throws) on lookup failure — an audit run that
 * can't read usage for one integration should still audit the rest rather
 * than aborting entirely.
 */
export async function getUsageForIntegration(
  integration: string
): Promise<Record<string, CapabilityUsageInfo>> {
  try {
    const rows = await (prisma as any).apiCapabilityUsage.findMany({
      where: { integration },
    });

    const result: Record<string, CapabilityUsageInfo> = {};
    for (const row of rows as Array<{ capability: string; callCount: number; lastUsedAt: Date | null }>) {
      result[row.capability] = { callCount: row.callCount, lastUsedAt: row.lastUsedAt };
    }
    return result;
  } catch (err) {
    logger.warn("[api-scope-audit] Failed to read capability usage", { integration, err });
    return {};
  }
}
