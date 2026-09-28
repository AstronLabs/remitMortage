-- Issue #781: in-app support chat, one conversation per applicant wallet.
-- The counterparty is the single admin/support identity (requireAdmin),
-- matching this codebase's single-admin model.

CREATE TABLE "SupportConversation" (
  "id" TEXT NOT NULL,
  "walletAddress" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportConversation_walletAddress_key" ON "SupportConversation"("walletAddress");
CREATE INDEX "SupportConversation_status_idx" ON "SupportConversation"("status");

CREATE TABLE "SupportChatMessage" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "senderRole" TEXT NOT NULL,
  "senderAddress" TEXT,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportChatMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportChatMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SupportChatMessage_conversationId_createdAt_idx" ON "SupportChatMessage"("conversationId", "createdAt");
