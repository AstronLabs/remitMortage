// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "../services/db.js";
import { getBrandedHtml, sendEmail } from "../services/email.js";
import logger from "../utils/logger.js";

const THRESHOLDS_DAYS = [30, 7] as const;

function buildReminderHtml(
  daysRemaining: number,
  docName: string,
  expiresAt: Date
): string {
  const subject = `Action Required: KYC Document Expiring in ${daysRemaining} Days`;
  const body = `
    <h2>KYC Document Expiry Reminder</h2>
    <p>Your submitted identity document is expiring soon. Please renew it before the
       expiry date to avoid disruption to your RemitMortgage account and any active
       loan submissions.</p>
    <table class="details-table">
      <tr>
        <td class="details-label">Document</td>
        <td class="details-value">${docName}</td>
      </tr>
      <tr>
        <td class="details-label">Expires On</td>
        <td class="details-value"><strong>${expiresAt.toDateString()}</strong></td>
      </tr>
      <tr>
        <td class="details-label">Days Remaining</td>
        <td class="details-value" style="color: ${daysRemaining <= 7 ? "#dc2626" : "#d97706"};">
          <strong>${daysRemaining} days</strong>
        </td>
      </tr>
    </table>
    <p>Log in to the dashboard and upload a renewed document before expiry.
       Expired documents will block new loan submissions until replaced.</p>
    <a href="#" class="cta-button">Update KYC Documents</a>
  `;
  return getBrandedHtml(subject, body);
}

/**
 * Scans KycDocument records and:
 * - Sends 30-day and 7-day reminder emails to the owning applicant.
 * - Marks documents whose expiresAt has passed as expired=true.
 *
 * Exported for direct invocation (tests / admin trigger).
 */
export async function runKycExpiryReminderJob(): Promise<{
  reminded: number;
  flaggedExpired: number;
}> {
  logger.info("[kyc-expiry] Starting KYC expiry reminder sweep");

  const now = new Date();
  let reminded = 0;
  let flaggedExpired = 0;

  // ── 1. Flag newly-expired documents ─────────────────────────────────────
  const justExpired = await prisma.kycDocument.updateMany({
    where: {
      expired: false,
      expiresAt: { lte: now },
    },
    data: { expired: true },
  });
  flaggedExpired = justExpired.count;

  if (flaggedExpired > 0) {
    logger.warn(`[kyc-expiry] Flagged ${flaggedExpired} document(s) as expired`);
  }

  // ── 2. Send 30-day reminders ─────────────────────────────────────────────
  const in30days = new Date(now);
  in30days.setDate(in30days.getDate() + 30);

  const due30 = await prisma.kycDocument.findMany({
    where: {
      expired: false,
      reminderSent30d: false,
      expiresAt: { gte: now, lte: in30days },
    },
    include: { applicant: true },
  });

  for (const doc of due30) {
    const email = `${doc.applicant.stellarAddress}@example.com`;
    const daysLeft = Math.ceil(
      (doc.expiresAt!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    const html = buildReminderHtml(daysLeft, doc.originalName, doc.expiresAt!);
    const ok = await sendEmail(
      email,
      `Action Required: KYC Document Expiring in ${daysLeft} Days`,
      html
    );
    if (ok) {
      await prisma.kycDocument.update({
        where: { id: doc.id },
        data: { reminderSent30d: true },
      });
      reminded++;
      logger.info(`[kyc-expiry] 30-day reminder sent`, {
        documentId: doc.documentId,
        applicantId: doc.applicantId,
        daysLeft,
      });
    } else {
      logger.warn(`[kyc-expiry] Failed to send 30-day reminder`, {
        documentId: doc.documentId,
      });
    }
  }

  // ── 3. Send 7-day reminders ──────────────────────────────────────────────
  const in7days = new Date(now);
  in7days.setDate(in7days.getDate() + 7);

  const due7 = await prisma.kycDocument.findMany({
    where: {
      expired: false,
      reminderSent7d: false,
      expiresAt: { gte: now, lte: in7days },
    },
    include: { applicant: true },
  });

  for (const doc of due7) {
    const email = `${doc.applicant.stellarAddress}@example.com`;
    const daysLeft = Math.ceil(
      (doc.expiresAt!.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)
    );
    const html = buildReminderHtml(daysLeft, doc.originalName, doc.expiresAt!);
    const ok = await sendEmail(
      email,
      `Urgent: KYC Document Expiring in ${daysLeft} Days`,
      html
    );
    if (ok) {
      await prisma.kycDocument.update({
        where: { id: doc.id },
        data: { reminderSent7d: true },
      });
      reminded++;
      logger.info(`[kyc-expiry] 7-day reminder sent`, {
        documentId: doc.documentId,
        applicantId: doc.applicantId,
        daysLeft,
      });
    } else {
      logger.warn(`[kyc-expiry] Failed to send 7-day reminder`, {
        documentId: doc.documentId,
      });
    }
  }

  logger.info("[kyc-expiry] Sweep complete", { reminded, flaggedExpired });
  return { reminded, flaggedExpired };
}

/**
 * Checks whether a borrower (by applicantId) has any expired KYC documents.
 * Used by the loan application route to block submissions.
 */
export async function hasExpiredKycDocuments(applicantId: string): Promise<boolean> {
  const count = await prisma.kycDocument.count({
    where: { applicantId, expired: true },
  });
  return count > 0;
}
