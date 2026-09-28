// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import SupportChatWidget from "../SupportChatWidget";

const fetchOrCreateConversationMock = jest.fn();
const fetchMessagesMock = jest.fn();
const sendMessageMock = jest.fn();
const notifyTypingStateMock = jest.fn();

jest.mock("@/lib/supportChatApi", () => ({
  fetchOrCreateConversation: (...args: unknown[]) => fetchOrCreateConversationMock(...args),
  fetchMessages: (...args: unknown[]) => fetchMessagesMock(...args),
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  notifyTypingState: (...args: unknown[]) => notifyTypingStateMock(...args),
  supportChatStreamUrl: () => "http://localhost:4000/api/support-chat/stream",
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string, public opts?: unknown) {
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

const AGENT_MESSAGE = {
  id: "msg-agent-1",
  conversationId: "conv-1",
  senderRole: "AGENT" as const,
  senderAddress: null,
  content: "Hi, how can I help?",
  createdAt: "2026-09-27T10:00:00.000Z",
};

beforeEach(() => {
  jest.useFakeTimers();
  FakeEventSource.instances = [];
  (global as any).EventSource = FakeEventSource;
  fetchOrCreateConversationMock.mockReset().mockResolvedValue({
    id: "conv-1",
    walletAddress: "GUSER",
    status: "OPEN",
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
  });
  fetchMessagesMock.mockReset().mockResolvedValue([]);
  sendMessageMock.mockReset();
  notifyTypingStateMock.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  delete (global as any).EventSource;
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("SupportChatWidget (issue #781)", () => {
  it("loads and renders existing message history", async () => {
    fetchMessagesMock.mockResolvedValue([AGENT_MESSAGE]);

    render(<SupportChatWidget />);
    expect(screen.getByText(/loading conversation/i)).toBeInTheDocument();

    await flush();

    expect(await screen.findByText("Hi, how can I help?")).toBeInTheDocument();
  });

  it("shows the typing indicator when a remote 'typing' event arrives, and clears it on an explicit stop", async () => {
    render(<SupportChatWidget />);
    await flush();

    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0];

    expect(screen.queryByTestId("support-chat-typing-indicator")).not.toBeInTheDocument();

    act(() => {
      source.emit({ type: "typing", senderRole: "AGENT", isTyping: true });
    });
    expect(screen.getByTestId("support-chat-typing-indicator")).toBeInTheDocument();

    act(() => {
      source.emit({ type: "typing", senderRole: "AGENT", isTyping: false });
    });
    expect(screen.queryByTestId("support-chat-typing-indicator")).not.toBeInTheDocument();
  });

  it("auto-clears the typing indicator if the stop event is missed (timeout fallback)", async () => {
    render(<SupportChatWidget />);
    await flush();
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit({ type: "typing", senderRole: "AGENT", isTyping: true });
    });
    expect(screen.getByTestId("support-chat-typing-indicator")).toBeInTheDocument();

    // Default remote timeout in useTypingIndicator is 5000ms.
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(screen.queryByTestId("support-chat-typing-indicator")).not.toBeInTheDocument();
  });

  it("appends an incoming 'message' event from the stream to the conversation", async () => {
    render(<SupportChatWidget />);
    await flush();
    const source = FakeEventSource.instances[0];

    act(() => {
      source.emit({ type: "message", message: AGENT_MESSAGE });
    });

    expect(await screen.findByText("Hi, how can I help?")).toBeInTheDocument();
  });

  it("degrades gracefully with no EventSource support: chat still loads, indicator never appears", async () => {
    delete (global as any).EventSource;
    fetchMessagesMock.mockResolvedValue([AGENT_MESSAGE]);

    render(<SupportChatWidget />);
    await flush();

    expect(await screen.findByText("Hi, how can I help?")).toBeInTheDocument();
    expect(screen.queryByTestId("support-chat-typing-indicator")).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("sends a message, appends it locally, and notifies typing on input", async () => {
    sendMessageMock.mockResolvedValue({
      id: "msg-user-1",
      conversationId: "conv-1",
      senderRole: "USER",
      senderAddress: "GUSER",
      content: "hello",
      createdAt: "2026-09-27T10:05:00.000Z",
    });

    render(<SupportChatWidget />);
    await flush();

    const textarea = screen.getByPlaceholderText(/type a message/i);
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(notifyTypingStateMock).toHaveBeenCalledWith(true);

    const sendButton = screen.getByRole("button", { name: /send message/i });
    await act(async () => {
      fireEvent.click(sendButton);
      await Promise.resolve();
    });

    expect(sendMessageMock).toHaveBeenCalledWith("hello");
  });
});
