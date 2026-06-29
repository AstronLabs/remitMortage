import { unpinFileFromIPFS } from "./ipfs.js";
import logger from "../utils/logger.js";
import { logUnpinnedCid } from "./ipfsAudit.js";

/**
 * Unpins evidence from Pinata and records the outcome in the audit log.
 * Failures are logged as warnings and do not propagate.
 */
export async function unpinEvidenceCid(cid: string, proposalId?: string): Promise<void> {
  try {
    const result = await unpinFileFromIPFS(cid);
    await logUnpinnedCid({
      cid,
      proposalId,
      success: true,
      pinataStatus: result.status,
    });
  } catch (error: any) {
    const message = error?.message ?? "Unknown unpin error";
    logger.warn(`[IPFSCleanup] Failed to unpin CID ${cid}`, { message });
    await logUnpinnedCid({
      cid,
      proposalId,
      success: false,
      error: message,
    }).catch((auditError) => {
      logger.warn(`[IPFSCleanup] Failed to write unpin audit log for CID ${cid}`, { auditError });
    });
  }
}
