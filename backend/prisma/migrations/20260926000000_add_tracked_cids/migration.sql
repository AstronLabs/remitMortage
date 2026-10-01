CREATE TABLE "TrackedCid" (
    "id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpinnedAt" TIMESTAMP(3),
    "markedOrphanAt" TIMESTAMP(3),

    CONSTRAINT "TrackedCid_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackedCid_cid_key" ON "TrackedCid"("cid");
CREATE INDEX "TrackedCid_referenceType_referenceId_idx" ON "TrackedCid"("referenceType", "referenceId");
CREATE INDEX "TrackedCid_pinnedAt_idx" ON "TrackedCid"("pinnedAt");
CREATE INDEX "TrackedCid_unpinnedAt_idx" ON "TrackedCid"("unpinnedAt");

CREATE TABLE "MilestoneEvidenceReference" (
    "proposalId" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MilestoneEvidenceReference_pkey" PRIMARY KEY ("proposalId", "cid")
);

CREATE INDEX "MilestoneEvidenceReference_cid_idx" ON "MilestoneEvidenceReference"("cid");
