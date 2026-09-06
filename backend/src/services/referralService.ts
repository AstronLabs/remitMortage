import { createHash } from "crypto";
import { prisma } from "./db.js";

function makeReferralCode(ownerAddress: string): string {
  const digest = createHash("sha256").update(ownerAddress).digest("hex");
  return `RM-${digest.slice(0, 8).toUpperCase()}`;
}

export async function getOrCreateReferralCode(ownerAddress: string) {
  const existing = await prisma.referralCode.findUnique({
    where: { ownerAddress },
  });
  if (existing) return existing;

  let code = makeReferralCode(ownerAddress);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.referralCode.create({
        data: { ownerAddress, code },
      });
    } catch {
      code = `${makeReferralCode(ownerAddress)}${attempt + 1}`;
    }
  }

  throw new Error("failed_to_generate_referral_code");
}

export async function attributeReferral(code: string, referredAddress: string) {
  const normalizedCode = code.trim().toUpperCase();
  const referral = await prisma.referralCode.findUnique({
    where: { code: normalizedCode },
  });
  if (!referral) {
    return { ok: false as const, error: "invalid_code" };
  }

  if (referral.ownerAddress === referredAddress) {
    return { ok: false as const, error: "self_referral_not_allowed" };
  }

  const existing = await prisma.referralAttribution.findUnique({
    where: { referredAddress },
  });
  if (existing) {
    return { ok: true as const, alreadyAttributed: true, attributionId: existing.id };
  }

  const attribution = await prisma.referralAttribution.create({
    data: {
      referralCodeId: referral.id,
      referredAddress,
    },
  });

  await prisma.auditLog.create({
    data: {
      action: "referral.attributed",
      actorAddress: referredAddress,
      metadata: {
        referralCode: normalizedCode,
        referrerAddress: referral.ownerAddress,
        attributionId: attribution.id,
      },
    },
  });

  return { ok: true as const, alreadyAttributed: false, attributionId: attribution.id };
}

export async function getReferralStats(ownerAddress: string) {
  const referral = await prisma.referralCode.findUnique({
    where: { ownerAddress },
    include: {
      attributions: {
        orderBy: { createdAt: "desc" },
      },
    },
  });

  if (!referral) {
    return {
      code: null,
      inviteLink: null,
      invitesSent: 0,
      conversions: 0,
      recentAttributions: [] as Array<{ referredAddress: string; createdAt: string }>,
    };
  }

  const referredAddresses = referral.attributions.map((a) => a.referredAddress);
  const convertedApplicants = referredAddresses.length
    ? await prisma.applicant.findMany({
        where: {
          stellarAddress: { in: referredAddresses },
          deletedAt: null,
          verificationStatus: "ELIGIBLE",
        },
        select: { stellarAddress: true },
      })
    : [];

  const baseUrl = process.env.FRONTEND_BASE_URL ?? "http://localhost:3000";

  return {
    code: referral.code,
    inviteLink: `${baseUrl}/onboarding?ref=${encodeURIComponent(referral.code)}`,
    invitesSent: referral.attributions.length,
    conversions: convertedApplicants.length,
    recentAttributions: referral.attributions.slice(0, 10).map((a) => ({
      referredAddress: a.referredAddress,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
