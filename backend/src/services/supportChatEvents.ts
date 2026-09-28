// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * In-process pub/sub for support-chat realtime events (issue #781).
 *
 * A single Node process is enough for this backend's current deployment —
 * no other realtime feature in this codebase requires cross-instance
 * fanout either. If this backend is ever horizontally scaled, this module
 * is the seam to swap for a shared broker (Redis pub/sub, etc.) without
 * touching callers.
 */

import { EventEmitter } from "events";

export type SupportChatSenderRole = "USER" | "AGENT";

export interface SupportChatMessagePayload {
  id: string;
  conversationId: string;
  senderRole: SupportChatSenderRole;
  senderAddress: string | null;
  content: string;
  createdAt: string;
}

export type SupportChatEvent =
  | { type: "message"; message: SupportChatMessagePayload }
  | { type: "typing"; senderRole: SupportChatSenderRole; isTyping: boolean };

const emitter = new EventEmitter();
// Unbounded: every open SSE connection for a conversation is a listener, and
// a busy conversation could plausibly exceed Node's default limit of 10.
emitter.setMaxListeners(0);

function channel(conversationId: string): string {
  return `support-chat:${conversationId}`;
}

/** Publishes an event to every subscriber currently watching this conversation. */
export function publishSupportChatEvent(conversationId: string, event: SupportChatEvent): void {
  emitter.emit(channel(conversationId), event);
}

/**
 * Subscribes to a conversation's events. Returns an unsubscribe function —
 * callers (SSE route handlers) must call it on client disconnect to avoid
 * leaking listeners.
 */
export function subscribeToSupportChat(
  conversationId: string,
  handler: (event: SupportChatEvent) => void
): () => void {
  const name = channel(conversationId);
  emitter.on(name, handler);
  return () => emitter.off(name, handler);
}

/** Test/diagnostic helper: how many active subscribers a conversation currently has. */
export function subscriberCount(conversationId: string): number {
  return emitter.listenerCount(channel(conversationId));
}
