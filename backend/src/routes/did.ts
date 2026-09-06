import { Router, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth.js";
import jwt from "jsonwebtoken";
import logger from "../utils/logger.js";
import { validateMultiChainOwnership } from "../middleware/validate.js";
import { authMiddleware } from "../middleware/auth.js";
import {
  parseDidDocument,
  verifyDidProof,
  createDidChallenge,
} from "../services/did.js";
import { prisma } from "../services/db.js";

export const didRouter = Router();

didRouter.post("/challenge", validateMultiChainOwnership, (req, res) => {
  const { walletAddress } = req.body;
  const challenge = createDidChallenge(walletAddress);
  res.json({ challenge });
});

didRouter.post("/verify", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { didDocument, proof } = req.body;

    if (!didDocument || !proof) {
      res.status(400).json({
        error: "missing_field",
        message: "didDocument and proof are required",
      });
      return;
    }

    if (!proof.challenge || !proof.signature || !proof.signerAddress) {
      res.status(400).json({
        error: "missing_field",
        message: "proof.challenge, proof.signature, and proof.signerAddress are required",
      });
      return;
    }

    const parsed = parseDidDocument(didDocument);
    if (!parsed.valid) {
      res.status(400).json({
        error: "invalid_did_document",
        message: "DID document validation failed",
        details: parsed.errors,
      });
      return;
    }

    const result = verifyDidProof(parsed.doc, proof);

    if (!result.verified) {
      res.status(401).json({
        error: "verification_failed",
        message: "Cryptographic proof verification failed",
        did: result.did,
        method: result.method,
      });
      return;
    }

    const user = req.user as { walletAddress: string } | undefined;
    const walletAddress = user?.walletAddress ?? proof.signerAddress;

    const applicant = await prisma.applicant.findFirst({
      where: { stellarAddress: walletAddress, deletedAt: null },
    });

    if (!applicant) {
      res.status(404).json({
        error: "applicant_not_found",
        message: "No applicant found for the given wallet address. Complete verification first.",
      });
      return;
    }

    const credential = await prisma.borrowerCredential.upsert({
      where: { did: result.did },
      update: {
        didHash: result.didHash,
        verificationMethod: result.verificationMethodType,
        challenge: proof.challenge,
        verifiedAt: new Date(),
        isRevoked: false,
        revokedAt: null,
      },
      create: {
        applicantId: applicant.id,
        did: result.did,
        didHash: result.didHash,
        verificationMethod: result.verificationMethodType,
        challenge: proof.challenge,
      },
    });

    const token = jwt.sign(
      { walletAddress, did: result.did, didHash: result.didHash },
      process.env.JWT_SECRET || "default_jwt_secret",
      { expiresIn: "24h" }
    );

    res.cookie("session", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.json({
      verified: true,
      did: result.did,
      didHash: result.didHash,
      method: result.method,
      verificationMethod: result.verificationMethodType,
      credentialId: credential.id,
    });
  } catch (error) {
    logger.error("DID verification error", { error });
    res.status(500).json({ error: "DID verification service failed" });
  }
});

didRouter.get("/credential/:did", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { did } = req.params as { did: string };
    const credential = await prisma.borrowerCredential.findUnique({
      where: { did },
      include: { applicant: true },
    });

    if (!credential) {
      res.status(404).json({ error: "credential_not_found" });
      return;
    }

    res.json({
      id: credential.id,
      did: credential.did,
      didHash: credential.didHash,
      verificationMethod: credential.verificationMethod,
      verifiedAt: credential.verifiedAt,
      expiresAt: credential.expiresAt,
      isRevoked: credential.isRevoked,
    });
  } catch (error) {
    logger.error("DID credential fetch error", { error });
    res.status(500).json({ error: "Failed to fetch DID credential" });
  }
});

didRouter.get("/applicant/:address", authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { address } = req.params as { address: string };
    const applicant = await prisma.applicant.findFirst({
      where: { stellarAddress: address, deletedAt: null },
      include: { borrowerCredentials: true },
    });

    if (!applicant) {
      res.status(404).json({ error: "applicant_not_found" });
      return;
    }

    res.json({
      stellarAddress: applicant.stellarAddress,
      credentials: applicant.borrowerCredentials.map((c: { did: string; didHash: string; verificationMethod: string; verifiedAt: Date; isRevoked: boolean }) => ({
        did: c.did,
        didHash: c.didHash,
        verificationMethod: c.verificationMethod,
        verifiedAt: c.verifiedAt,
        isRevoked: c.isRevoked,
      })),
    });
  } catch (error) {
    logger.error("DID applicant fetch error", { error });
    res.status(500).json({ error: "Failed to fetch applicant credentials" });
  }
});
