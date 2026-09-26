// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Email bounce/complaint handling and suppression list (issue #694).
 *
 * The email provider's event webhook feeds bounce and complaint events into
 * `recordEmailEvent`, and every outbound send calls `isEmailSuppressed` first.
 *
 * - Hard bounce   → permanent suppression.
 * - Spam complaint → permanent suppression + `flaggedForReview` for staff.
 * - Soft bounce   → suppressed for an exponential backoff window, so the next
 *   send after the window is the retry; after `SOFT_BOUNCE_LIMIT` consecutive
 *   soft bounces the address is treated as permanently undeliverable.
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";

export type BounceKind = "hard" | "soft" | "complaint";

/** First soft-bounce backoff window; doubles on each further soft bounce. */
export const SOFT_BOUNCE_BASE_BACKOFF_MS = 15 * 60 * 1000;
/** Upper bound on a single soft-bounce backoff window. */
export const SOFT_BOUNCE_MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
/** Consecutive soft bounces after which the address is suppressed permanently. */
export const SOFT_BOUNCE_LIMIT = 5;

/** Subset of a SendGrid Event Webhook event that bounce handling reads. */
export interface ProviderEmailEvent {
  email?: unknown;
  event?: unknown;
  /** SendGrid: `bounce` (hard) or `blocked` (soft) on `event: "bounce"`. */
  type?: unknown;
  reason?: unknown;
  response?: unknown;
  timestamp?: unknown;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Map a provider event to a bounce kind, or `null` for events that do not
 * affect deliverability (delivered, open, click, ...).
 */
export function classifyProviderEvent(
  event: ProviderEmailEvent,
): BounceKind | null {
  switch (event.event) {
    case "spamreport":
      return "complaint";
    case "bounce":
      // SendGrid marks temporary rejections as `type: "blocked"`.
      return event.type === "blocked" ? "soft" : "hard";
    case "blocked":
    case "deferred":
      return "soft";
    case "dropped":
      // Dropped because the address is already known bad at the provider.
      return typeof event.reason === "string" &&
        /bounc|invalid/i.test(event.reason)
        ? "hard"
        : null;
    default:
      return null;
  }
}

/** Backoff window for the `softBounceCount`-th consecutive soft bounce (1-based). */
export function softBounceBackoffMs(softBounceCount: number): number {
  const exponent = Math.max(0, softBounceCount - 1);
  return Math.min(
    SOFT_BOUNCE_BASE_BACKOFF_MS * 2 ** exponent,
    SOFT_BOUNCE_MAX_BACKOFF_MS,
  );
}

function eventDetail(event: ProviderEmailEvent): string | null {
  const detail = event.reason ?? event.response;
  return typeof detail === "string" ? detail.slice(0, 500) : null;
}

/**
 * Apply one provider event to the suppression list. Returns the bounce kind
 * recorded, or `null` if the event was ignored.
 */
export async function recordEmailEvent(
  event: ProviderEmailEvent,
  now: Date = new Date(),
): Promise<BounceKind | null> {
  const kind = classifyProviderEvent(event);
  if (!kind || typeof event.email !== "string" || !event.email.includes("@")) {
    return null;
  }

  const email = normalizeEmail(event.email);
  const lastDetail = eventDetail(event);
  const existing = await prisma.emailSuppression.findUnique({
    where: { email },
  });

  if (kind === "hard" || kind === "complaint") {
    const reason = kind === "complaint" ? "SPAM_COMPLAINT" : "HARD_BOUNCE";
    // A complaint is never downgraded to a hard bounce.
    const keepComplaint = existing?.reason === "SPAM_COMPLAINT";
    const data = {
      reason: keepComplaint ? ("SPAM_COMPLAINT" as const) : reason,
      permanent: true,
      suppressedUntil: null,
      flaggedForReview:
        kind === "complaint" || (existing?.flaggedForReview ?? false),
      lastDetail,
      lastEventAt: now,
    };
    await prisma.emailSuppression.upsert({
      where: { email },
      create: { email, ...data },
      update: data,
    });
    logger.warn(
      `[emailSuppression] ${email} permanently suppressed (${data.reason})`,
    );
    return kind;
  }

  // Soft bounce: an already-permanent entry stays permanent.
  if (existing?.permanent) {
    await prisma.emailSuppression.update({
      where: { email },
      data: { lastDetail, lastEventAt: now },
    });
    return kind;
  }

  const softBounceCount = (existing?.softBounceCount ?? 0) + 1;
  const exhausted = softBounceCount >= SOFT_BOUNCE_LIMIT;
  const data = {
    reason: exhausted ? ("HARD_BOUNCE" as const) : ("SOFT_BOUNCE" as const),
    permanent: exhausted,
    softBounceCount,
    suppressedUntil: exhausted
      ? null
      : new Date(now.getTime() + softBounceBackoffMs(softBounceCount)),
    lastDetail,
    lastEventAt: now,
  };
  await prisma.emailSuppression.upsert({
    where: { email },
    create: { email, ...data },
    update: data,
  });
  return kind;
}

/**
 * Whether sends to `email` must be skipped right now. Fails open (returns
 * false) if the suppression list cannot be read, so a database outage never
 * blocks all outbound mail.
 */
export async function isEmailSuppressed(
  email: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const entry = await prisma.emailSuppression.findUnique({
      where: { email: normalizeEmail(email) },
    });
    if (!entry) return false;
    if (entry.permanent) return true;
    return entry.suppressedUntil !== null && entry.suppressedUntil > now;
  } catch (error) {
    logger.error(
      "[emailSuppression] Suppression lookup failed; sending anyway",
      { error },
    );
    return false;
  }
}

export interface SuppressedApplicant {
  email: string;
  reason: string;
  permanent: boolean;
  flaggedForReview: boolean;
  suppressedUntil: Date | null;
  lastDetail: string | null;
  lastEventAt: Date;
  applicants: { applicantId: string; stellarAddress: string }[];
}

interface SuppressionRow {
  email: string;
  reason: string;
  permanent: boolean;
  flaggedForReview: boolean;
  suppressedUntil: Date | null;
  lastDetail: string | null;
  lastEventAt: Date;
}

interface PreferenceRow {
  email: string | null;
  applicantId: string;
  applicant: { stellarAddress: string };
}

/**
 * Suppressed addresses (permanent, or still inside a soft-bounce window) with
 * the applicants whose notification email matches, so admins can prompt them
 * to update their contact info.
 */
export async function listSuppressedApplicants(
  now: Date = new Date(),
  limit = 200,
): Promise<SuppressedApplicant[]> {
  const entries: SuppressionRow[] = await prisma.emailSuppression.findMany({
    where: { OR: [{ permanent: true }, { suppressedUntil: { gt: now } }] },
    orderBy: { lastEventAt: "desc" },
    take: limit,
  });
  if (entries.length === 0) return [];

  const preferences: PreferenceRow[] =
    await prisma.notificationPreference.findMany({
      where: {
        email: { in: entries.map((e) => e.email), mode: "insensitive" },
      },
      select: {
        email: true,
        applicantId: true,
        applicant: { select: { stellarAddress: true } },
      },
    });

  return entries.map((entry) => ({
    email: entry.email,
    reason: entry.reason,
    permanent: entry.permanent,
    flaggedForReview: entry.flaggedForReview,
    suppressedUntil: entry.suppressedUntil,
    lastDetail: entry.lastDetail,
    lastEventAt: entry.lastEventAt,
    applicants: preferences
      .filter(
        (p) => p.email !== null && normalizeEmail(p.email) === entry.email,
      )
      .map((p) => ({
        applicantId: p.applicantId,
        stellarAddress: p.applicant.stellarAddress,
      })),
  }));
}
