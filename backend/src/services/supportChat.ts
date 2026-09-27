// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * In-app support chat (issue #781): one conversation per applicant wallet,
 * the counterparty always the single admin/support identity.
 *
 * Typing-state debounce: `setTypingState` is the one place a "typing" event
 * actually reaches the other party. The frontend already debounces bursts of
 * keystrokes into infrequent start/stop calls (see
 * `frontend/src/hooks/useTypingIndicator.ts`), but this is re-applied
 * server-side as a defense-in-depth measure — a misbehaving or malicious
 * client sending the same state repeatedly should not flood every open SSE
 * connection on the conversation.
 */

import { prisma } from "./db.js";
import logger from "../utils/logger.js";
import {
  publishSupportChatEvent,
  type SupportChatMessagePayload,
  type SupportChatSenderRole,
} from "./supportChatEvents.js";

export const MAX_MESSAGE_LENGTH = 4000;

/** Minimum time between two identical typing-state broadcasts from the same sender/conversation. */
export const TYPING_REPEAT_SUPPRESSION_MS = 2000;

export class SupportChatValidationError extends Error {}

export async function getOrCreateConversation(walletAddress: string) {
  const existing = await (prisma as any).supportConversation.findUnique({
    where: { walletAddress },
  });
  if (existing) return existing;

  return (prisma as any).supportConversation.create({
    data: { walletAddress },
  });
}

export async function getConversationById(conversationId: string) {
  return (prisma as any).supportConversation.findUnique({ where: { id: conversationId } });
}

export async function getConversationByWallet(walletAddress: string) {
  return (prisma as any).supportConversation.findUnique({ where: { walletAddress } });
}

export async function listMessages(conversationId: string, limit = 200) {
  return (prisma as any).supportChatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
}

function toPayload(message: {
  id: string;
  conversationId: string;
  senderRole: string;
  senderAddress: string | null;
  content: string;
  createdAt: Date;
}): SupportChatMessagePayload {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderRole: message.senderRole as SupportChatSenderRole,
    senderAddress: message.senderAddress,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

export async function postMessage(
  conversationId: string,
  senderRole: SupportChatSenderRole,
  senderAddress: string | null,
  rawContent: string
) {
  const content = typeof rawContent === "string" ? rawContent.trim() : "";
  if (!content) {
    throw new SupportChatValidationError("Message content must not be empty.");
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new SupportChatValidationError(
      `Message content must be ${MAX_MESSAGE_LENGTH} characters or fewer.`
    );
  }

  const message = await (prisma as any).supportChatMessage.create({
    data: { conversationId, senderRole, senderAddress, content },
  });

  await (prisma as any).supportConversation.update({
    where: { id: conversationId },
    data: { updatedAt: new Date() },
  });

  publishSupportChatEvent(conversationId, { type: "message", message: toPayload(message) });

  return message;
}

/** Last broadcast typing state per (conversationId, senderRole), for repeat suppression. */
const lastTypingBroadcast = new Map<string, { isTyping: boolean; at: number }>();

function typingKey(conversationId: string, senderRole: SupportChatSenderRole): string {
  return `${conversationId}:${senderRole}`;
}

/**
 * Broadcasts a typing-state change to the conversation's other party.
 *
 * Suppresses redundant broadcasts: the same `isTyping` value from the same
 * sender within `TYPING_REPEAT_SUPPRESSION_MS` is dropped rather than
 * re-published, so a client that (mis)fires "typing" on every keystroke
 * without its own debounce still can't flood connected listeners. A
 * genuine state *change* (typing -> stopped, or vice versa) is always sent
 * immediately regardless of timing.
 */
export function setTypingState(
  conversationId: string,
  senderRole: SupportChatSenderRole,
  isTyping: boolean
): boolean {
  const key = typingKey(conversationId, senderRole);
  const last = lastTypingBroadcast.get(key);
  const now = Date.now();

  if (last && last.isTyping === isTyping && now - last.at < TYPING_REPEAT_SUPPRESSION_MS) {
    return false;
  }

  lastTypingBroadcast.set(key, { isTyping, at: now });
  publishSupportChatEvent(conversationId, { type: "typing", senderRole, isTyping });
  return true;
}

/** Test-only: clears the repeat-suppression cache between test cases. */
export function resetTypingSuppressionState(): void {
  lastTypingBroadcast.clear();
}

export async function listOpenConversations(limit = 100) {
  try {
    return await (prisma as any).supportConversation.findMany({
      where: { status: "OPEN" },
      orderBy: { updatedAt: "desc" },
      take: limit,
    });
  } catch (err) {
    logger.error("[support-chat] Failed to list open conversations", { err });
    throw err;
  }
}
