// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unified applicant communication timeline (issue #674).
 *
 * Support staff investigating an applicant currently have to check email
 * (`Notification` rows with type EMAIL), SMS (`Notification` rows with type
 * SMS) and in-app notification history (`InAppNotification`) separately.
 * This merges all three, resolved from the applicant's `NotificationPreference`
 * (email/phone) and `Applicant.stellarAddress` (in-app), into one
 * chronological feed so staff can answer "did they actually receive our
 * reminder?" from a single view.
 */

import { prisma as defaultPrisma } from "./db.js";

export type CommunicationChannel = "EMAIL" | "SMS" | "IN_APP";

export interface CommunicationTimelineEntry {
  id: string;
  channel: CommunicationChannel;
  status: string;
  summary: string;
  recipient: string;
  occurredAt: Date;
  attempts?: number;
  lastError?: string | null;
  read?: boolean;
}

export interface ApplicantCommunicationTimeline {
  applicantId: string;
  stellarAddress: string;
  email: string | null;
  phone: string | null;
  entries: CommunicationTimelineEntry[];
}

function summarizeNotificationContent(content: string): string {
  const trimmed = content.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.template) return `Template: ${parsed.template}`;
      if (parsed.event) return `Event: ${parsed.event}${parsed.subject ? ` — ${parsed.subject}` : ""}`;
    } catch {
      // fall through to plain-text truncation
    }
  }
  const stripped = trimmed.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > 160 ? `${stripped.slice(0, 157)}...` : stripped;
}

export interface GetApplicantCommunicationTimelineOptions {
  prisma?: typeof defaultPrisma;
  /** Max entries returned per channel before merging. Defaults to 100. */
  limitPerChannel?: number;
}

/**
 * Finds the applicant by id or stellar address and merges their email, SMS,
 * webhook, and in-app notification history into one timeline, newest first.
 */
export async function getApplicantCommunicationTimeline(
  applicantIdentifier: string,
  options: GetApplicantCommunicationTimelineOptions = {}
): Promise<ApplicantCommunicationTimeline | null> {
  const prisma = options.prisma ?? defaultPrisma;
  const limitPerChannel = options.limitPerChannel ?? 100;

  const applicant = await prisma.applicant.findFirst({
    where: {
      OR: [{ id: applicantIdentifier }, { stellarAddress: applicantIdentifier }],
    },
    include: { notificationPreference: true },
  });

  if (!applicant) return null;

  const email = applicant.notificationPreference?.email ?? null;
  const phone = applicant.notificationPreference?.phone ?? null;

  const [emailNotifications, smsNotifications, inAppNotifications] = await Promise.all([
    email
      ? prisma.notification.findMany({
          where: { type: "EMAIL", recipient: email },
          orderBy: { createdAt: "desc" },
          take: limitPerChannel,
        })
      : Promise.resolve([]),
    phone
      ? prisma.notification.findMany({
          where: { type: "SMS", recipient: phone },
          orderBy: { createdAt: "desc" },
          take: limitPerChannel,
        })
      : Promise.resolve([]),
    prisma.inAppNotification.findMany({
      where: { walletAddress: applicant.stellarAddress },
      orderBy: { createdAt: "desc" },
      take: limitPerChannel,
    }),
  ]);

  const entries: CommunicationTimelineEntry[] = [
    ...emailNotifications.map((n: any) => ({
      id: n.id,
      channel: "EMAIL" as const,
      status: n.status,
      summary: summarizeNotificationContent(n.content),
      recipient: n.recipient,
      occurredAt: n.createdAt,
      attempts: n.attempts,
      lastError: n.lastError,
    })),
    ...smsNotifications.map((n: any) => ({
      id: n.id,
      channel: "SMS" as const,
      status: n.status,
      summary: summarizeNotificationContent(n.content),
      recipient: n.recipient,
      occurredAt: n.createdAt,
      attempts: n.attempts,
      lastError: n.lastError,
    })),
    ...inAppNotifications.map((n: any) => ({
      id: n.id,
      channel: "IN_APP" as const,
      status: n.read ? "Read" : "Unread",
      summary: n.message ? `${n.title}: ${n.message}` : n.title,
      recipient: n.walletAddress,
      occurredAt: n.createdAt,
      read: n.read,
    })),
  ].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  return {
    applicantId: applicant.id,
    stellarAddress: applicant.stellarAddress,
    email,
    phone,
    entries,
  };
}
