// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Investor watchlist for upcoming loan offerings (issue #799).
 *
 * This backend has no separate "offering" entity — a loan is an upcoming
 * offering while it is still `Pending` (in underwriting) and opens for
 * investment when it is approved. A watch is therefore keyed to the
 * `LoanApplication`, and `notifyWatchersOfOpenedOffering` is the hook the
 * approve transition calls.
 *
 * Only anonymized offering terms (principal, rate, submission date) are ever
 * exposed to investors here — never the borrower's identity.
 */

import { prisma } from "./db.js";
import { createInAppNotification } from "./db.js";
import logger from "../utils/logger.js";

export type OfferingState = "upcoming" | "open" | "closed";

export class OfferingWatchError extends Error {
  constructor(
    message: string,
    public readonly code: "offering_not_found" | "offering_not_watchable"
  ) {
    super(message);
  }
}

export interface UpcomingOffering {
  id: string;
  principal: number;
  interestRateBps: number;
  createdAt: string;
  watched: boolean;
}

export interface WatchlistItem {
  loanId: string;
  principal: number;
  interestRateBps: number;
  state: OfferingState;
  watchedSince: string;
  /** Set once the investor has been notified that the offering opened. */
  notifiedAt: string | null;
}

/** Maps a loan status onto what an investor cares about. */
export function offeringStateForStatus(status: string): OfferingState {
  if (status === "Pending" || status === "Draft") return "upcoming";
  if (status === "Rejected") return "closed";
  return "open";
}

export async function listUpcomingOfferings(investorAddress: string): Promise<UpcomingOffering[]> {
  const loans = await (prisma as any).loanApplication.findMany({
    where: { status: "Pending", deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, principal: true, interestRateBps: true, createdAt: true },
  });

  const watches = await (prisma as any).offeringWatch.findMany({
    where: { investorAddress, loanApplicationId: { in: loans.map((l: any) => l.id) } },
    select: { loanApplicationId: true },
  });
  const watched = new Set<string>(watches.map((w: any) => w.loanApplicationId));

  return loans.map((l: any) => ({
    id: l.id,
    principal: l.principal,
    interestRateBps: l.interestRateBps,
    createdAt: new Date(l.createdAt).toISOString(),
    watched: watched.has(l.id),
  }));
}

/** Idempotent: watching an already-watched offering is a no-op. */
export async function watchOffering(investorAddress: string, loanId: string) {
  const loan = await (prisma as any).loanApplication.findFirst({
    where: { id: loanId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!loan) {
    throw new OfferingWatchError("Offering not found.", "offering_not_found");
  }
  if (loan.status !== "Pending") {
    throw new OfferingWatchError(
      "Only upcoming offerings that have not yet opened for investment can be watched.",
      "offering_not_watchable"
    );
  }

  return (prisma as any).offeringWatch.upsert({
    where: { investorAddress_loanApplicationId: { investorAddress, loanApplicationId: loanId } },
    update: {},
    create: { investorAddress, loanApplicationId: loanId },
  });
}

/** Returns whether a watch existed. Unwatching something not watched is not an error. */
export async function unwatchOffering(investorAddress: string, loanId: string): Promise<boolean> {
  const result = await (prisma as any).offeringWatch.deleteMany({
    where: { investorAddress, loanApplicationId: loanId },
  });
  return result.count > 0;
}

export async function listWatchlist(investorAddress: string): Promise<WatchlistItem[]> {
  const watches = await (prisma as any).offeringWatch.findMany({
    where: { investorAddress },
    orderBy: { createdAt: "desc" },
    include: {
      loanApplication: { select: { principal: true, interestRateBps: true, status: true } },
    },
  });

  return watches.map((w: any) => ({
    loanId: w.loanApplicationId,
    principal: w.loanApplication.principal,
    interestRateBps: w.loanApplication.interestRateBps,
    state: offeringStateForStatus(w.loanApplication.status),
    watchedSince: new Date(w.createdAt).toISOString(),
    notifiedAt: w.notifiedAt ? new Date(w.notifiedAt).toISOString() : null,
  }));
}

function describeOffering(principal: number, interestRateBps: number): string {
  return `$${principal.toLocaleString("en-US")} at ${(interestRateBps / 100).toFixed(2)}% APR`;
}

/**
 * Notifies every investor watching `loanId` that it has opened for
 * investment. Idempotent per watch (`notifiedAt`), and a failure for one
 * investor never prevents the rest from being notified. Never throws — the
 * approval that triggers this must not fail because a notification did.
 *
 * Returns the number of investors notified.
 */
export async function notifyWatchersOfOpenedOffering(loanId: string): Promise<number> {
  try {
    const watches = await (prisma as any).offeringWatch.findMany({
      where: { loanApplicationId: loanId, notifiedAt: null },
      include: {
        loanApplication: { select: { principal: true, interestRateBps: true } },
      },
    });

    let notified = 0;
    for (const watch of watches) {
      try {
        await createInAppNotification({
          walletAddress: watch.investorAddress,
          title: "Watched offering is now open",
          message: `An offering you're watching (${describeOffering(
            watch.loanApplication.principal,
            watch.loanApplication.interestRateBps
          )}) is now open for investment.`,
          variant: "success",
          metadata: { type: "OFFERING_OPENED", loanId, role: "investor" },
        });
        await (prisma as any).offeringWatch.update({
          where: { id: watch.id },
          data: { notifiedAt: new Date() },
        });
        notified += 1;
      } catch (err) {
        logger.warn("[offering-watchlist] Failed to notify watcher", {
          loanId,
          investorAddress: watch.investorAddress,
          err,
        });
      }
    }
    return notified;
  } catch (err) {
    logger.error("[offering-watchlist] Failed to dispatch open-offering notifications", {
      loanId,
      err,
    });
    return 0;
  }
}
