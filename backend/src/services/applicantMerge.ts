// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { prisma } from "./db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class MergeValidationError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface MergeContext {
  actorAddress?: string | null;
  ipAddress?: string | null;
  reason?: string;
}

export interface MergeResult {
  primaryApplicantId: string;
  duplicateApplicantId: string;
  moved: {
    loanApplications: number;
    verificationResults: number;
    kycDocuments: number;
    borrowerCredentials: number;
  };
  duplicateDeletedAt: Date;
}

export async function mergeApplicants(
  primaryApplicantId: string,
  duplicateApplicantId: string,
  ctx: MergeContext = {},
): Promise<MergeResult> {
  if (!primaryApplicantId || !duplicateApplicantId) {
    throw new MergeValidationError(400, "invalid_request", "primaryApplicantId and duplicateApplicantId are required");
  }
  if (!UUID_RE.test(primaryApplicantId) || !UUID_RE.test(duplicateApplicantId)) {
    throw new MergeValidationError(400, "invalid_request", "applicant IDs must be valid UUIDs");
  }
  if (primaryApplicantId === duplicateApplicantId) {
    throw new MergeValidationError(400, "invalid_request", "primary and duplicate applicant IDs must differ");
  }

  const [primary, duplicate] = await Promise.all([
    prisma.applicant.findUnique({ where: { id: primaryApplicantId } }),
    prisma.applicant.findUnique({ where: { id: duplicateApplicantId } }),
  ]);

  if (!primary) {
    throw new MergeValidationError(404, "applicant_not_found", `primary applicant not found: ${primaryApplicantId}`);
  }
  if (!duplicate) {
    throw new MergeValidationError(404, "applicant_not_found", `duplicate applicant not found: ${duplicateApplicantId}`);
  }
  if (primary.deletedAt) {
    throw new MergeValidationError(409, "conflict", "primary applicant is deleted");
  }
  if (duplicate.deletedAt) {
    throw new MergeValidationError(409, "conflict", "duplicate applicant is already deleted");
  }

  const result = await prisma.$transaction(async (tx: any) => {
    const loanRes = await tx.loanApplication.updateMany({
      where: { applicantId: duplicateApplicantId },
      data: { applicantId: primaryApplicantId },
    });

    const vrRes = await tx.verificationResult.updateMany({
      where: { applicantId: duplicateApplicantId },
      data: { applicantId: primaryApplicantId },
    });

    const kycRes = await tx.kycDocument.updateMany({
      where: { applicantId: duplicateApplicantId },
      data: { applicantId: primaryApplicantId },
    });

    const bcRes = await tx.borrowerCredential.updateMany({
      where: { applicantId: duplicateApplicantId },
      data: { applicantId: primaryApplicantId },
    });

    // NotificationPreference is @unique on applicantId — keep primary's, delete duplicate's if collision
    const dupPref = await tx.notificationPreference.findUnique({
      where: { applicantId: duplicateApplicantId },
    });
    const primPref = await tx.notificationPreference.findUnique({
      where: { applicantId: primaryApplicantId },
    });
    if (dupPref && !primPref) {
      await tx.notificationPreference.update({
        where: { applicantId: duplicateApplicantId },
        data: { applicantId: primaryApplicantId },
      });
    } else if (dupPref && primPref) {
      await tx.notificationPreference.delete({
        where: { applicantId: duplicateApplicantId },
      });
    }

    // Re-point audit logs where actorAddress matches duplicate's stellarAddress (if any)
    // This covers the only indexed applicant linkage on AuditLog; JSON metadata patching
    // is handled via the explicit merge audit entry below which references both IDs.
    if (duplicate.stellarAddress) {
      // Best-effort: move actorAddress-scoped logs to primary's address
      // If primary's address is the surviving identity, keep it; otherwise coalesce under primary
      try {
        await tx.auditLog.updateMany({
          where: { actorAddress: duplicate.stellarAddress },
          data: { actorAddress: primary.stellarAddress },
        });
      } catch {
        // AuditLog update may fail on some adapters — non-fatal for merge
      }
    }

    const deleted = await tx.applicant.update({
      where: { id: duplicateApplicantId },
      data: { deletedAt: new Date(), updatedAt: new Date() },
    });

    await tx.auditLog.create({
      data: {
        action: "applicant.merge",
        actorAddress: ctx.actorAddress ?? null,
        ipAddress: ctx.ipAddress ?? null,
        metadata: {
          primaryApplicantId,
          duplicateApplicantId,
          primaryStellarAddress: primary.stellarAddress,
          duplicateStellarAddress: duplicate.stellarAddress,
          moved: {
            loanApplications: loanRes.count,
            verificationResults: vrRes.count,
            kycDocuments: kycRes.count,
            borrowerCredentials: bcRes.count,
          },
          reason: ctx.reason ?? null,
          mergedAt: new Date().toISOString(),
        },
      },
    });

    return {
      primaryApplicantId,
      duplicateApplicantId,
      moved: {
        loanApplications: loanRes.count,
        verificationResults: vrRes.count,
        kycDocuments: kycRes.count,
        borrowerCredentials: bcRes.count,
      },
      duplicateDeletedAt: deleted.deletedAt as Date,
    } satisfies MergeResult;
  });

  return result;
}
