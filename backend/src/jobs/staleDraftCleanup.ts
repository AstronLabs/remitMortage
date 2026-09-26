// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";
import { sendEmail, getBrandedHtml } from "../services/email.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface StaleDraftCleanupSummary {
  flaggedCount: number;
  expiredCount: number;
}

/**
 * Scans Draft loan applications for inactivity. Drafts idle past
 * `draftStaleThresholdDays` are flagged and the applicant notified once;
 * drafts that remain unresumed for `draftStaleExpiryGraceDays` after that
 * notice are soft-deleted (expired). Any activity on a draft — including a
 * resume — resets `lastActivityAt` and clears the notice, taking it out of
 * scope for expiry.
 */
export async function runStaleDraftCleanupJob(): Promise<StaleDraftCleanupSummary> {
  const config = loadConfig();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - config.draftStaleThresholdDays * MS_PER_DAY);
  const expiryCutoff = new Date(now.getTime() - config.draftStaleExpiryGraceDays * MS_PER_DAY);

  logger.info("[StaleDraftCleanup] Starting stale draft scan", {
    thresholdDays: config.draftStaleThresholdDays,
    graceDays: config.draftStaleExpiryGraceDays,
  });

  // 1. Flag drafts that just crossed the inactivity threshold and notify the applicant.
  const newlyStale = await prisma.loanApplication.findMany({
    where: {
      status: "Draft",
      deletedAt: null,
      draftStaleNotifiedAt: null,
      lastActivityAt: { lt: staleCutoff },
    },
    include: { applicant: true },
  });

  let flaggedCount = 0;
  for (const draft of newlyStale) {
    const email = draft.applicant?.stellarAddress ? `${draft.applicant.stellarAddress}@example.com` : null;

    if (email) {
      try {
        await sendEmail(
          email,
          "Your mortgage application draft is about to expire",
          getBrandedHtml(
            "Draft Application Inactive",
            `<p>Your in-progress loan application (${draft.id}) has had no activity for ${config.draftStaleThresholdDays} days.</p>
             <p>It will be automatically discarded in ${config.draftStaleExpiryGraceDays} days unless you resume it.</p>`
          )
        );
      } catch (err) {
        logger.error("[StaleDraftCleanup] Failed to send stale draft notice", { err, draftId: draft.id });
      }
    }

    await prisma.loanApplication.update({
      where: { id: draft.id },
      data: { draftStaleNotifiedAt: now },
    });
    flaggedCount++;
  }

  // 2. Expire (soft-delete) drafts that were notified and never resumed within the grace window.
  const expired = await prisma.loanApplication.updateMany({
    where: {
      status: "Draft",
      deletedAt: null,
      draftStaleNotifiedAt: { lt: expiryCutoff },
    },
    data: { deletedAt: now },
  });

  logger.info("[StaleDraftCleanup] Completed stale draft scan", {
    flaggedCount,
    expiredCount: expired.count,
  });

  return { flaggedCount, expiredCount: expired.count };
}
