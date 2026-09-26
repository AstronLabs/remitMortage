import type { TrackedCidRecord } from "../services/ipfsCidTracker.js";

jest.mock("../services/ipfsCidTracker.js", () => ({
  hasMilestoneEvidenceReference: jest.fn(),
  listActiveCids: jest.fn(),
  markCidOrphan: jest.fn(),
  markCidUnpinned: jest.fn(),
}));
jest.mock("../services/ipfsCleanup.js", () => ({
  unpinEvidenceCid: jest.fn(),
}));
jest.mock("../services/milestoneProposalStore.js", () => ({
  getProposal: jest.fn(),
}));
jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import {
  hasMilestoneEvidenceReference,
  listActiveCids,
  markCidOrphan,
  markCidUnpinned,
} from "../services/ipfsCidTracker.js";
import { unpinEvidenceCid } from "../services/ipfsCleanup.js";
import { getProposal } from "../services/milestoneProposalStore.js";
import logger from "../utils/logger.js";
import {
  isCidReferenced,
  runOrphanCleanup,
} from "../jobs/ipfsOrphanCleanup.js";

const mockHasReference = hasMilestoneEvidenceReference as jest.Mock;
const mockListActive = listActiveCids as jest.Mock;
const mockMarkOrphan = markCidOrphan as jest.Mock;
const mockMarkUnpinned = markCidUnpinned as jest.Mock;
const mockUnpin = unpinEvidenceCid as jest.Mock;
const mockGetProposal = getProposal as jest.Mock;

function record(overrides: Partial<TrackedCidRecord> = {}): TrackedCidRecord {
  return {
    id: "tracked-1",
    cid: "bafy-orphan",
    referenceType: "milestone_evidence",
    referenceId: "upload:bafy-orphan",
    pinnedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    unpinnedAt: null,
    markedOrphanAt: null,
    ...overrides,
  };
}

describe("IPFS orphan cleanup", () => {
  const originalGracePeriod = process.env.IPFS_ORPHAN_GRACE_PERIOD_HOURS;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.IPFS_ORPHAN_GRACE_PERIOD_HOURS = "24";
    mockListActive.mockResolvedValue([record()]);
    mockHasReference.mockResolvedValue(false);
    mockMarkOrphan.mockResolvedValue(undefined);
    mockMarkUnpinned.mockResolvedValue(undefined);
    mockUnpin.mockResolvedValue(undefined);
    mockGetProposal.mockReturnValue(null);
  });

  afterAll(() => {
    if (originalGracePeriod === undefined) {
      delete process.env.IPFS_ORPHAN_GRACE_PERIOD_HOURS;
    } else {
      process.env.IPFS_ORPHAN_GRACE_PERIOD_HOURS = originalGracePeriod;
    }
  });

  it("detects and reclaims a CID with no valid reference after the grace period", async () => {
    const result = await runOrphanCleanup();

    expect(result).toEqual(expect.objectContaining({
      checked: 1,
      orphaned: 1,
      reclaimed: 1,
      unpinned: 1,
      failed: 0,
    }));
    expect(mockMarkOrphan).toHaveBeenCalledWith("bafy-orphan");
    expect(mockUnpin).toHaveBeenCalledWith("bafy-orphan", "upload:bafy-orphan", {
      throwOnError: true,
    });
    expect(mockMarkUnpinned).toHaveBeenCalledWith("bafy-orphan");
  });

  it("never checks references or unpins while the CID is within the grace period", async () => {
    mockListActive.mockResolvedValue([
      record({ pinnedAt: new Date(Date.now() - 60 * 60 * 1000) }),
    ]);

    const result = await runOrphanCleanup();

    expect(result.skippedGracePeriod).toBe(1);
    expect(mockHasReference).not.toHaveBeenCalled();
    expect(mockUnpin).not.toHaveBeenCalled();
  });

  it("preserves a CID with a durable proposal reference", async () => {
    mockHasReference.mockResolvedValue(true);

    const result = await runOrphanCleanup();

    expect(result.referenced).toBe(1);
    expect(mockUnpin).not.toHaveBeenCalled();
    expect(mockMarkOrphan).not.toHaveBeenCalled();
  });

  it("preserves a proposal that is live in the current process", async () => {
    const liveProposal = {
      id: "proposal-1",
      evidenceCid: "bafy-orphan",
      status: "Open",
    };
    mockGetProposal.mockReturnValue(liveProposal);

    await expect(isCidReferenced(record({ referenceId: "proposal-1" }))).resolves.toBe(true);
  });

  it("records a storage failure without marking the CID reclaimed", async () => {
    mockUnpin.mockRejectedValue(new Error("Pinata unavailable"));

    const result = await runOrphanCleanup();

    expect(result.orphaned).toBe(1);
    expect(result.reclaimed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.storageErrors).toBe(1);
    expect(mockMarkUnpinned).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenLastCalledWith(
      "[IPFSOrphanCleanup] Cleanup complete",
      expect.objectContaining({ checked: 1, orphaned: 1, reclaimed: 0, errors: 1 })
    );
  });

  it("fails closed if checking database references fails", async () => {
    mockHasReference.mockRejectedValue(new Error("database unavailable"));

    const result = await runOrphanCleanup();

    expect(result.failed).toBe(1);
    expect(mockUnpin).not.toHaveBeenCalled();
  });

  it("logs a cleanup summary when the tracker query fails", async () => {
    mockListActive.mockRejectedValue(new Error("database unavailable"));

    const result = await runOrphanCleanup();

    expect(result.checked).toBe(0);
    expect(result.failed).toBe(1);
    expect(logger.info).toHaveBeenLastCalledWith(
      "[IPFSOrphanCleanup] Cleanup complete",
      expect.objectContaining({ checked: 0, errors: 1 })
    );
  });
});
