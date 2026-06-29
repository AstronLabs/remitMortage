import { Router } from "express";
import multer from "multer";
import logger from "../utils/logger.js";
import { pinFileToIPFS, unpinFileFromIPFS } from "../services/ipfs.js";
import { logUnpinnedCid } from "../services/ipfsAudit.js";
import { unpinEvidenceCid } from "../services/ipfsCleanup.js";
import {
  createProposal,
  getProposal,
  updateProposal,
} from "../services/milestoneProposalStore.js";

export const milestoneRouter = Router();

// Configure multer storage in memory
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB size limit
  },
});

const uploadSingle = upload.single("file");

/**
 * @openapi
 * /api/milestone/upload:
 *   post:
 *     summary: Upload and pin milestone progress evidence to IPFS
 *     description: Accepts multipart/form-data with a single file (max 10MB), validates type (JPEG, PNG, WEBP, MP4), and pins it to IPFS via Pinata.
 *     tags:
 *       - Milestone
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: File pinned successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cid:
 *                   type: string
 *                 ipfsUrl:
 *                   type: string
 *                 size:
 *                   type: number
 *       400:
 *         description: Missing or invalid file type.
 *       413:
 *         description: File size exceeds 10MB.
 *       500:
 *         description: Pinning operation failed.
 */
milestoneRouter.post("/upload", (req, res, next) => {
  uploadSingle(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({
          error: "file_too_large",
          message: "File size exceeds the 10MB limit.",
        });
      }
      return res.status(400).json({ error: err.code, message: err.message });
    } else if (err) {
      return res.status(500).json({ error: "upload_failed", message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        error: "missing_file",
        message: "No file was uploaded. Please attach a file to the request.",
      });
    }

    // Validate MIME types (images: jpg/png/webp, video: mp4)
    const allowedMimeTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
    ];

    if (!allowedMimeTypes.includes(file.mimetype)) {
      return res.status(400).json({
        error: "invalid_file_type",
        message: "Invalid file type. Only JPEG, PNG, WEBP images and MP4 videos are allowed.",
      });
    }

    // Pin the file to IPFS
    const cid = await pinFileToIPFS(file.buffer, file.originalname);
    const ipfsUrl = `https://gateway.pinata.cloud/ipfs/${cid}`;

    return res.status(201).json({
      cid,
      ipfsUrl,
      size: file.size,
    });
  } catch (error: any) {
    logger.error("[MilestoneUpload] Error in upload route", { error });
    return res.status(500).json({
      error: "ipfs_pinning_failed",
      message: error.message || "Failed to upload and pin file to IPFS.",
    });
  }
});

/**
 * @openapi
 * /api/milestone/unpin/{cid}:
 *   delete:
 *     summary: Unpin milestone evidence from Pinata IPFS
 *     description: Removes a pinned file from Pinata storage by CID and records the action in the audit log.
 *     tags:
 *       - Milestone
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File unpinned successfully.
 *       500:
 *         description: Unpin operation failed.
 */
milestoneRouter.delete("/unpin/:cid", async (req, res) => {
  const { cid } = req.params;

  if (!cid) {
    return res.status(400).json({ error: "missing_cid", message: "CID is required." });
  }

  try {
    const result = await unpinFileFromIPFS(cid);
    await logUnpinnedCid({
      cid,
      success: true,
      pinataStatus: result.status,
    });
    return res.json({ cid: result.cid, status: result.status });
  } catch (error: any) {
    logger.warn("[MilestoneUnpin] Error unpinning CID", { message: error.message });
    await logUnpinnedCid({
      cid,
      success: false,
      error: error.message,
    }).catch((auditError) => {
      logger.warn("[MilestoneUnpin] Failed to write audit log", { auditError });
    });
    return res.status(500).json({
      error: "ipfs_unpin_failed",
      message: error.message || "Failed to unpin file from IPFS.",
    });
  }
});

/**
 * @openapi
 * /api/milestone/proposals:
 *   post:
 *     summary: Register a milestone proposal with evidence CID
 *     tags:
 *       - Milestone
 */
milestoneRouter.post("/proposals", async (req, res) => {
  const { milestoneId, evidenceCid } = req.body ?? {};

  if (!milestoneId || !evidenceCid) {
    return res.status(400).json({
      error: "missing_fields",
      message: "milestoneId and evidenceCid are required.",
    });
  }

  const proposal = createProposal(String(milestoneId), String(evidenceCid));
  return res.status(201).json(proposal);
});

/**
 * @openapi
 * /api/milestone/proposals/{id}/reject:
 *   post:
 *     summary: Reject a milestone proposal and unpin its evidence from IPFS
 *     tags:
 *       - Milestone
 */
milestoneRouter.post("/proposals/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body ?? {};
  const proposal = getProposal(id);

  if (!proposal) {
    return res.status(404).json({ error: "not_found", message: "Proposal not found." });
  }

  if (proposal.status !== "Open") {
    return res.status(400).json({
      error: "invalid_state",
      message: "Proposal must be Open to reject.",
    });
  }

  const updated = updateProposal(id, {
    status: "Rejected",
    reason: reason ?? "Rejected by governance multisig",
  });

  if (proposal.evidenceCid) {
    unpinEvidenceCid(proposal.evidenceCid, id).catch((err) => {
      logger.warn(`[MilestoneReject] Background unpin failed for proposal ${id}`, { err });
    });
  }

  return res.json(updated);
});
