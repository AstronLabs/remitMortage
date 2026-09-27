// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the in-app support chat service (issue #781).
 *
 * Acceptance criteria under test (typing-indicator half of the ticket —
 * message CRUD is necessary plumbing, covered incidentally):
 * 1. A typing-state change is published as an event other subscribers can
 *    observe, debounced server-side against repeat broadcasts.
 * 2. Message validation rejects empty/oversized content without touching
 *    the realtime channel.
 */

const conversationStore = new Map<string, any>();
const messageStore: any[] = [];

jest.mock("../services/db.js", () => ({
  prisma: {
    supportConversation: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.id) return conversationStore.get(where.id) ?? null;
        if (where.walletAddress) {
          return (
            Array.from(conversationStore.values()).find(
              (c) => c.walletAddress === where.walletAddress
            ) ?? null
          );
        }
        return null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const conversation = {
          id: `conv-${conversationStore.size + 1}`,
          status: "OPEN",
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        conversationStore.set(conversation.id, conversation);
        return conversation;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const conversation = conversationStore.get(where.id);
        Object.assign(conversation, data);
        return conversation;
      }),
      findMany: jest.fn(async () => Array.from(conversationStore.values())),
    },
    supportChatMessage: {
      create: jest.fn(async ({ data }: any) => {
        const message = { id: `msg-${messageStore.length + 1}`, createdAt: new Date(), ...data };
        messageStore.push(message);
        return message;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        messageStore.filter((m) => m.conversationId === where.conversationId)
      ),
    },
  },
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

import {
  getOrCreateConversation,
  listMessages,
  postMessage,
  resetTypingSuppressionState,
  setTypingState,
  SupportChatValidationError,
  MAX_MESSAGE_LENGTH,
  TYPING_REPEAT_SUPPRESSION_MS,
} from "../services/supportChat.js";
import { subscribeToSupportChat } from "../services/supportChatEvents.js";

beforeEach(() => {
  conversationStore.clear();
  messageStore.length = 0;
  resetTypingSuppressionState();
  jest.clearAllMocks();
});

describe("getOrCreateConversation", () => {
  it("creates exactly one conversation per wallet across repeated calls", async () => {
    const first = await getOrCreateConversation("GWALLET1");
    const second = await getOrCreateConversation("GWALLET1");
    expect(second.id).toBe(first.id);
    expect(conversationStore.size).toBe(1);
  });
});

describe("postMessage (issue #781)", () => {
  it("rejects empty content without publishing an event", async () => {
    const conversation = await getOrCreateConversation("GWALLET2");
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat(conversation.id, (e) => events.push(e));

    await expect(postMessage(conversation.id, "USER", "GWALLET2", "   ")).rejects.toBeInstanceOf(
      SupportChatValidationError
    );
    expect(events).toHaveLength(0);
    unsubscribe();
  });

  it("rejects content over the maximum length", async () => {
    const conversation = await getOrCreateConversation("GWALLET3");
    const tooLong = "a".repeat(MAX_MESSAGE_LENGTH + 1);
    await expect(postMessage(conversation.id, "USER", "GWALLET3", tooLong)).rejects.toBeInstanceOf(
      SupportChatValidationError
    );
  });

  it("trims content, persists the message, and publishes a message event", async () => {
    const conversation = await getOrCreateConversation("GWALLET4");
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat(conversation.id, (e) => events.push(e));

    const message = await postMessage(conversation.id, "AGENT", null, "  hello there  ");

    expect(message.content).toBe("hello there");
    const stored = await listMessages(conversation.id);
    expect(stored).toHaveLength(1);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "message",
      message: expect.objectContaining({ content: "hello there", senderRole: "AGENT" }),
    });
    unsubscribe();
  });
});

describe("setTypingState (issue #781)", () => {
  it("publishes a typing event to subscribers of the conversation", () => {
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat("conv-typing-1", (e) => events.push(e));

    const broadcast = setTypingState("conv-typing-1", "USER", true);

    expect(broadcast).toBe(true);
    expect(events).toEqual([{ type: "typing", senderRole: "USER", isTyping: true }]);
    unsubscribe();
  });

  it("suppresses a repeated identical state within the suppression window", () => {
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat("conv-typing-2", (e) => events.push(e));

    expect(setTypingState("conv-typing-2", "USER", true)).toBe(true);
    // Same sender, same state, immediately again — should be suppressed.
    expect(setTypingState("conv-typing-2", "USER", true)).toBe(false);

    expect(events).toHaveLength(1);
    unsubscribe();
  });

  it("always broadcasts a genuine state change, even immediately after suppression", () => {
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat("conv-typing-3", (e) => events.push(e));

    expect(setTypingState("conv-typing-3", "USER", true)).toBe(true);
    expect(setTypingState("conv-typing-3", "USER", true)).toBe(false); // suppressed repeat
    expect(setTypingState("conv-typing-3", "USER", false)).toBe(true); // genuine change

    expect(events.map((e) => e.isTyping)).toEqual([true, false]);
    unsubscribe();
  });

  it("re-allows a repeated identical state once the suppression window has elapsed", () => {
    jest.useFakeTimers();
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat("conv-typing-4", (e) => events.push(e));

    expect(setTypingState("conv-typing-4", "USER", true)).toBe(true);
    jest.advanceTimersByTime(TYPING_REPEAT_SUPPRESSION_MS + 1);
    expect(setTypingState("conv-typing-4", "USER", true)).toBe(true);

    expect(events).toHaveLength(2);
    unsubscribe();
    jest.useRealTimers();
  });

  it("tracks suppression independently per sender role on the same conversation", () => {
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat("conv-typing-5", (e) => events.push(e));

    expect(setTypingState("conv-typing-5", "USER", true)).toBe(true);
    // Different role, same conversation, same instant — not a repeat of USER's state.
    expect(setTypingState("conv-typing-5", "AGENT", true)).toBe(true);

    expect(events).toHaveLength(2);
    unsubscribe();
  });

  it("never notifies a conversation's own past subscribers after unsubscribe", () => {
    const events: any[] = [];
    const unsubscribe = subscribeToSupportChat("conv-typing-6", (e) => events.push(e));
    unsubscribe();

    setTypingState("conv-typing-6", "USER", true);
    expect(events).toHaveLength(0);
  });
});
