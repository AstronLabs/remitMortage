"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useRef, useState } from "react";
import { MessageCircle, Send } from "lucide-react";
import { useTypingIndicator } from "@/hooks/useTypingIndicator";
import {
  fetchMessages,
  fetchOrCreateConversation,
  notifyTypingState,
  sendMessage as sendSupportChatMessage,
  supportChatStreamUrl,
  type SupportChatMessage,
  type SupportChatStreamEvent,
} from "@/lib/supportChatApi";

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * In-app support chat widget (issue #781), including a realtime typing
 * indicator for the support agent's side of the conversation.
 *
 * The typing signal rides the same best-effort SSE stream as new messages.
 * If that stream never connects (`EventSource` unsupported, network down,
 * server unreachable), this degrades gracefully: the chat still loads and
 * sends messages over plain `fetch`, the indicator just never appears —
 * see `useTypingIndicator`'s `receiveRemoteTypingEvent`, which is simply
 * never called in that case.
 */
export function SupportChatWidget() {
  const [messages, setMessages] = useState<SupportChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const seenMessageIds = useRef<Set<string>>(new Set());

  const { notifyTyping, isOtherPartyTyping, receiveRemoteTypingEvent } = useTypingIndicator({
    onLocalTypingChange: (isTyping) => {
      void notifyTypingState(isTyping);
    },
  });

  const appendMessage = useCallback((message: SupportChatMessage) => {
    if (seenMessageIds.current.has(message.id)) return;
    seenMessageIds.current.add(message.id);
    setMessages((prev) => [...prev, message]);
  }, []);

  // Bootstrap: conversation + history.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        await fetchOrCreateConversation();
        const history = await fetchMessages();
        if (cancelled) return;
        history.forEach((m) => seenMessageIds.current.add(m.id));
        setMessages(history);
      } catch {
        if (!cancelled) setLoadError("Couldn't load the support chat. Please try again shortly.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Realtime stream: new messages + the agent's typing state. Best-effort —
  // see the module doc comment above for the degradation behavior.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      return;
    }

    const source = new EventSource(supportChatStreamUrl(), { withCredentials: true });

    source.onmessage = (event) => {
      let payload: SupportChatStreamEvent;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      if (payload.type === "message") {
        appendMessage(payload.message);
      } else if (payload.type === "typing") {
        receiveRemoteTypingEvent(payload.isTyping);
      }
    };

    source.onerror = () => {
      // The channel may recover on its own (EventSource auto-reconnects) —
      // just stop trusting any indicator state shown until it does.
      receiveRemoteTypingEvent(false);
    };

    return () => {
      source.close();
    };
  }, [appendMessage, receiveRemoteTypingEvent]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isOtherPartyTyping]);

  async function handleSend() {
    const content = draft.trim();
    if (!content || sending) return;

    setSending(true);
    try {
      const message = await sendSupportChatMessage(content);
      appendMessage(message);
      setDraft("");
    } catch {
      setLoadError("Your message couldn't be sent. Please try again.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[32rem] w-full max-w-md flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-950/95 shadow-xl shadow-black/40">
      <div className="flex items-center gap-2 border-b border-slate-800/80 px-4 py-3">
        <MessageCircle className="h-4 w-4 text-cyan-400" />
        <h2 className="text-sm font-semibold text-white">Support Chat</h2>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4" data-testid="support-chat-messages">
        {loading ? (
          <p className="text-xs text-slate-400">Loading conversation…</p>
        ) : messages.length === 0 ? (
          <p className="text-xs text-slate-400">
            Send a message and our support team will get back to you here.
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.senderRole === "USER" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                  message.senderRole === "USER"
                    ? "bg-cyan-500 text-slate-950"
                    : "bg-slate-800 text-slate-100"
                }`}
              >
                <p className="whitespace-pre-wrap break-words">{message.content}</p>
                <p
                  className={`mt-1 text-[10px] ${
                    message.senderRole === "USER" ? "text-slate-950/60" : "text-slate-400"
                  }`}
                >
                  {formatTime(message.createdAt)}
                </p>
              </div>
            </div>
          ))
        )}

        {isOtherPartyTyping && (
          <p
            data-testid="support-chat-typing-indicator"
            className="flex items-center gap-1 text-xs italic text-slate-400"
          >
            Support is typing
            <span className="animate-pulse">…</span>
          </p>
        )}

        <div ref={listEndRef} />
      </div>

      {loadError && <p className="px-4 pb-1 text-xs text-rose-400">{loadError}</p>}

      <div className="flex items-end gap-2 border-t border-slate-800/80 p-3">
        <textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (e.target.value.trim()) notifyTyping();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          rows={1}
          placeholder="Type a message…"
          className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sending || !draft.trim()}
          className="rounded-lg bg-cyan-500 p-2 text-slate-950 transition-opacity disabled:opacity-40"
          aria-label="Send message"
        >
          <Send className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

export default SupportChatWidget;
