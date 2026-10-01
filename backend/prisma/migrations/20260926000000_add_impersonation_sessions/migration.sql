CREATE TABLE "ImpersonationSession" (
  "id"            TEXT NOT NULL,
  "adminAddress"  TEXT NOT NULL,
  "targetAddress" TEXT NOT NULL,
  "reason"        TEXT,
  "ipAddress"     TEXT,
  "startedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     TIMESTAMP(3) NOT NULL,
  "endedAt"       TIMESTAMP(3),
  "endedBy"       TEXT,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ImpersonationSession_adminAddress_idx" ON "ImpersonationSession"("adminAddress");
CREATE INDEX "ImpersonationSession_targetAddress_idx" ON "ImpersonationSession"("targetAddress");
CREATE INDEX "ImpersonationSession_expiresAt_idx" ON "ImpersonationSession"("expiresAt");
