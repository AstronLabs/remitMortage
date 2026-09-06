import { Router } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import logger from "../utils/logger.js";
import {
  attributeReferral,
  getOrCreateReferralCode,
  getReferralStats,
} from "../services/referralService.js";

export const referralRouter = Router();

function validateAddress(address: string, field: string) {
  try {
    StrKey.decodeEd25519PublicKey(address);
    return null;
  } catch {
    return { error: "invalid_address", field, message: `Invalid Stellar G-address for ${field}` };
  }
}

referralRouter.get("/code", async (req, res) => {
  const ownerAddress = String(req.query.ownerAddress ?? "");
  if (!ownerAddress) {
    return res.status(400).json({ error: "missing_field", field: "ownerAddress" });
  }

  const invalid = validateAddress(ownerAddress, "ownerAddress");
  if (invalid) return res.status(400).json(invalid);

  try {
    const referral = await getOrCreateReferralCode(ownerAddress);
    const baseUrl = process.env.FRONTEND_BASE_URL ?? "http://localhost:3000";
    return res.json({
      code: referral.code,
      ownerAddress: referral.ownerAddress,
      inviteLink: `${baseUrl}/onboarding?ref=${encodeURIComponent(referral.code)}`,
      createdAt: referral.createdAt.toISOString(),
    });
  } catch (error) {
    logger.error("Referral code generation error", { error });
    return res.status(500).json({ error: "failed_to_generate_code" });
  }
});

referralRouter.get("/stats", async (req, res) => {
  const ownerAddress = String(req.query.ownerAddress ?? "");
  if (!ownerAddress) {
    return res.status(400).json({ error: "missing_field", field: "ownerAddress" });
  }

  const invalid = validateAddress(ownerAddress, "ownerAddress");
  if (invalid) return res.status(400).json(invalid);

  try {
    const stats = await getReferralStats(ownerAddress);
    return res.json(stats);
  } catch (error) {
    logger.error("Referral stats error", { error });
    return res.status(500).json({ error: "failed_to_load_stats" });
  }
});

referralRouter.post("/attribute", async (req, res) => {
  const { code, referredAddress } = req.body ?? {};
  if (!code || !referredAddress) {
    return res.status(400).json({
      error: "missing_fields",
      message: "code and referredAddress are required",
    });
  }

  const invalid = validateAddress(String(referredAddress), "referredAddress");
  if (invalid) return res.status(400).json(invalid);

  try {
    const result = await attributeReferral(String(code), String(referredAddress));
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }
    return res.status(result.alreadyAttributed ? 200 : 201).json(result);
  } catch (error) {
    logger.error("Referral attribution error", { error });
    return res.status(500).json({ error: "failed_to_attribute_referral" });
  }
});
