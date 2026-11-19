// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Accredited-investor periodic re-verification (issue #725).
 *
 * Accreditation can lapse without the platform noticing, so every tracked
 * investor carries a `lastVerifiedAt` date and a re-verification deadline of
 * `lastVerifiedAt + interval`. The timeline for an investor is:
 *
 *   current ── (reminder lead window) ──▶ due_soon ── deadline ──▶ overdue
 *                                                      ── grace period ──▶ lapsed
 *
 * - `due_soon`: a reminder is sent once.
 * - `overdue`: the deadline was missed; a follow-up is sent once. Investing
 *   is still allowed during the grace period.
 * - `lapsed`: the grace period has also passed. NEW investments are blocked
 *   until the investor is re-verified; existing holdings are never touched.
 *
 * Investors with no record are not tracked and are never restricted.
 *
 * Interval, reminder lead time and grace period are configurable:
 *   REVERIFICATION_INTERVAL_DAYS      (default 365)
 *   REVERIFICATION_REMINDER_LEAD_DAYS (default 30)
 *   REVERIFICATION_GRACE_DAYS         (default 30)
 */

import { prisma } from "./db.js";
import { createInAppNotification } from "./db.js";
import logger from "../utils/logger.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ReverificationStatus = "untracked" | "current" | "due_soon" | "overdue" | "lapsed";

export interface ReverificationConfig {
  intervalDays: number;
  reminderLeadDays: number;
  graceDays: number;
}

export interface ReverificationState {
  status: ReverificationStatus;
  lastVerifiedAt: string | null;
  dueAt: string | null;
  graceEndsAt: string | null;
  /** False only when the investor has lapsed past the grace period. */
  canInvest: boolean;
}

export class InvestmentRestrictedError extends Error {
  readonly code = "accreditation_lapsed";
  readonly httpStatus = 403;
  constructor(public readonly state: ReverificationState) {
    super(
      "Your accredited investor re-verification has lapsed. Re-verify to make new investments; existing holdings are unaffected."
    );
  }
}

function positiveDays(raw: string | undefined, fallback: number, allowZero = false): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || (allowZero ? n < 0 : n <= 0)) return fallback;
  return n;
}

/** Reads configuration at call time so it can be changed without a restart. */
export function getReverificationConfig(): ReverificationConfig {
  return {
    intervalDays: positiveDays(process.env.REVERIFICATION_INTERVAL_DAYS, 365),
    reminderLeadDays: positiveDays(process.env.REVERIFICATION_REMINDER_LEAD_DAYS, 30, true),
    graceDays: positiveDays(process.env.REVERIFICATION_GRACE_DAYS, 30, true),
  };
}

/** Pure status computation for a given last-verified date. */
export function computeReverificationState(
  lastVerifiedAt: Date | null,
  now: Date = new Date(),
  config: ReverificationConfig = getReverificationConfig()
): ReverificationState {
  if (!lastVerifiedAt) {
    return { status: "untracked", lastVerifiedAt: null, dueAt: null, graceEndsAt: null, canInvest: true };
  }
  const dueAt = new Date(lastVerifiedAt.getTime() + config.intervalDays * DAY_MS);
  const graceEndsAt = new Date(dueAt.getTime() + config.graceDays * DAY_MS);
  const reminderFrom = new Date(dueAt.getTime() - config.reminderLeadDays * DAY_MS);

  let status: ReverificationStatus;
  if (now >= graceEndsAt) status = "lapsed";
  else if (now >= dueAt) status = "overdue";
  else if (now >= reminderFrom) status = "due_soon";
  else status = "current";

  return {
    status,
    lastVerifiedAt: lastVerifiedAt.toISOString(),
    dueAt: dueAt.toISOString(),
    graceEndsAt: graceEndsAt.toISOString(),
    canInvest: status !== "lapsed",
  };
}

/**
 * Records a (re-)verification: starts or resets the investor's clock and
 * clears the reminder flags so the next cycle notifies again.
 */
export async function recordInvestorVerification(investorAddress: string, verifiedAt: Date = new Date()) {
  return (prisma as any).investorAccreditation.upsert({
    where: { investorAddress },
    create: { investorAddress, lastVerifiedAt: verifiedAt },
    update: { lastVerifiedAt: verifiedAt, reminderSentAt: null, missedReminderSentAt: null },
  });
}

export async function getReverificationState(
  investorAddress: string,
  now: Date = new Date()
): Promise<ReverificationState> {
  const record = await (prisma as any).investorAccreditation.findUnique({ where: { investorAddress } });
  return computeReverificationState(record ? new Date(record.lastVerifiedAt) : null, now);
}

/**
 * Gate for NEW investment actions. Throws {@link InvestmentRestrictedError}
 * when the investor's re-verification has lapsed past the grace period.
 * Existing holdings (withdrawals, claims, repayments received) must not call
 * this.
 */
export async function assertInvestmentAllowed(
  investorAddress: string,
  now: Date = new Date()
): Promise<ReverificationState> {
  const state = await getReverificationState(investorAddress, now);
  if (!state.canInvest) throw new InvestmentRestrictedError(state);
  return state;
}

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toDateString() : "";
}

/**
 * Sends the "deadline approaching" reminders and the "deadline missed"
 * follow-ups that are due. Each is sent at most once per verification cycle.
 * One investor's failure never stops the sweep.
 */
export async function runReverificationSweep(
  now: Date = new Date()
): Promise<{ reminded: number; followedUp: number }> {
  const config = getReverificationConfig();
  let reminded = 0;
  let followedUp = 0;

  // Candidates: not yet reminded and inside the reminder window.
  const reminderCutoff = new Date(now.getTime() - (config.intervalDays - config.reminderLeadDays) * DAY_MS);
  const dueForReminder = await (prisma as any).investorAccreditation.findMany({
    where: { reminderSentAt: null, lastVerifiedAt: { lte: reminderCutoff } },
  });

  for (const record of dueForReminder) {
    const state = computeReverificationState(new Date(record.lastVerifiedAt), now, config);
    // Past the deadline the follow-up below replaces the advance reminder.
    if (state.status !== "due_soon") continue;
    try {
      await createInAppNotification({
        walletAddress: record.investorAddress,
        title: "Accredited investor re-verification due soon",
        message: `Your accredited investor status must be re-verified by ${formatDate(
          state.dueAt
        )}. Re-verify before then to keep investing without interruption.`,
        variant: "warning",
        metadata: { type: "ACCREDITATION_REVERIFICATION_DUE", dueAt: state.dueAt, role: "investor" },
      });
      await (prisma as any).investorAccreditation.update({
        where: { id: record.id },
        data: { reminderSentAt: now },
      });
      reminded += 1;
    } catch (err) {
      logger.warn("[reverification] Failed to send reminder", { investorAddress: record.investorAddress, err });
    }
  }

  // Candidates: deadline missed and not yet followed up.
  const missedCutoff = new Date(now.getTime() - config.intervalDays * DAY_MS);
  const missed = await (prisma as any).investorAccreditation.findMany({
    where: { missedReminderSentAt: null, lastVerifiedAt: { lte: missedCutoff } },
  });

  for (const record of missed) {
    const state = computeReverificationState(new Date(record.lastVerifiedAt), now, config);
    if (state.status !== "overdue" && state.status !== "lapsed") continue;
    try {
      const message =
        state.status === "lapsed"
          ? "Your accredited investor re-verification has lapsed. New investments are blocked until you re-verify; your existing holdings are unaffected."
          : `You missed your accredited investor re-verification deadline (${formatDate(
              state.dueAt
            )}). Re-verify by ${formatDate(state.graceEndsAt)} to avoid new investments being blocked.`;
      await createInAppNotification({
        walletAddress: record.investorAddress,
        title: "Accredited investor re-verification overdue",
        message,
        variant: "error",
        metadata: { type: "ACCREDITATION_REVERIFICATION_MISSED", status: state.status, role: "investor" },
      });
      await (prisma as any).investorAccreditation.update({
        where: { id: record.id },
        data: { missedReminderSentAt: now },
      });
      followedUp += 1;
    } catch (err) {
      logger.warn("[reverification] Failed to send follow-up", { investorAddress: record.investorAddress, err });
    }
  }

  return { reminded, followedUp };
}
