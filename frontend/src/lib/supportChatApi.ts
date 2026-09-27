// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type SupportChatSenderRole = "USER" | "AGENT";

export interface SupportChatMessage {
  id: string;
  conversationId: string;
  senderRole: SupportChatSenderRole;
  senderAddress: string | null;
  content: string;
  createdAt: string;
}

export interface SupportConversation {
  id: string;
  walletAddress: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export type SupportChatStreamEvent =
  | { type: "message"; message: SupportChatMessage }
  | { type: "typing"; senderRole: SupportChatSenderRole; isTyping: boolean };

export async function fetchOrCreateConversation(): Promise<SupportConversation> {
  const res = await fetch(`${API_BASE}/api/support-chat`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load support conversation");
  }
  const body = await res.json();
  return body.conversation;
}

export async function fetchMessages(): Promise<SupportChatMessage[]> {
  const res = await fetch(`${API_BASE}/api/support-chat/messages`, { credentials: "include" });
  if (!res.ok) {
    throw new Error("Failed to load support chat messages");
  }
  const body = await res.json();
  return body.messages;
}

export async function sendMessage(content: string): Promise<SupportChatMessage> {
  const res = await fetch(`${API_BASE}/api/support-chat/messages`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to send message");
  }
  const body = await res.json();
  return body.message;
}

/** Never throws — a failed typing ping should never disrupt the chat. */
export async function notifyTypingState(isTyping: boolean): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/support-chat/typing`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isTyping }),
    });
  } catch {
    // Best-effort — the local UI already reflects typing state regardless.
  }
}

export function supportChatStreamUrl(): string {
  return `${API_BASE}/api/support-chat/stream`;
}
