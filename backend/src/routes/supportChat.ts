// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * In-app support chat, user-facing side (issue #781). Mounted at
 * `/api/support-chat` with `authMiddleware` applied at the mount point in
 * index.ts, so every route here has a verified `req.user.walletAddress`.
 *
 * The realtime stream (`GET /stream`) is plain Server-Sent Events rather
 * than a websocket library — this backend has no websocket transport
 * anywhere else, and SSE needs no new runtime dependency. `EventSource`
 * authenticates the same way as any other browser request here: the
 * HTTP-only session cookie (`withCredentials: true` on the client), which
 * `authMiddleware` already accepts alongside the Authorization header.
 */

import { Router, Response } from "express";
import logger from "../utils/logger.js";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import {
  getOrCreateConversation,
  listMessages,
  postMessage,
  setTypingState,
  SupportChatValidationError,
} from "../services/supportChat.js";
import { subscribeToSupportChat } from "../services/supportChatEvents.js";

export const supportChatRouter = Router();

/**
 * GET /api/support-chat
 * Bootstraps (creating if necessary) the caller's single support conversation.
 */
supportChatRouter.get("/", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const conversation = await getOrCreateConversation(walletAddress);
    return res.json({ conversation });
  } catch (error) {
    logger.error("[support-chat] Failed to get or create conversation", { error });
    return res.status(500).json({ error: "support_chat_unavailable" });
  }
});

/**
 * GET /api/support-chat/messages
 * Lists the caller's conversation history.
 */
supportChatRouter.get("/messages", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const conversation = await getOrCreateConversation(walletAddress);
    const messages = await listMessages(conversation.id);
    return res.json({ conversation, messages });
  } catch (error) {
    logger.error("[support-chat] Failed to list messages", { error });
    return res.status(500).json({ error: "support_chat_unavailable" });
  }
});

/**
 * POST /api/support-chat/messages
 * Sends a message as the authenticated user.
 */
supportChatRouter.post("/messages", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { content } = req.body ?? {};
  try {
    const conversation = await getOrCreateConversation(walletAddress);
    const message = await postMessage(conversation.id, "USER", walletAddress, content);
    return res.status(201).json({ message });
  } catch (error) {
    if (error instanceof SupportChatValidationError) {
      return res.status(400).json({ error: "invalid_message", message: error.message });
    }
    logger.error("[support-chat] Failed to post message", { error });
    return res.status(500).json({ error: "support_chat_unavailable" });
  }
});

/**
 * POST /api/support-chat/typing
 * Signals that the authenticated user has started or stopped typing.
 * Body: { isTyping: boolean }
 */
supportChatRouter.post("/typing", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const isTyping = Boolean(req.body?.isTyping);
  try {
    const conversation = await getOrCreateConversation(walletAddress);
    setTypingState(conversation.id, "USER", isTyping);
    return res.status(204).end();
  } catch (error) {
    logger.error("[support-chat] Failed to set typing state", { error });
    return res.status(500).json({ error: "support_chat_unavailable" });
  }
});

/**
 * GET /api/support-chat/stream
 * Server-Sent Events stream of the caller's conversation: `message` and
 * `typing` events from the AGENT side. The connection degrades gracefully
 * on the client if this never connects — see
 * `frontend/src/hooks/useTypingIndicator.ts`.
 */
supportChatRouter.get("/stream", async (req: AuthenticatedRequest, res: Response) => {
  const walletAddress = req.user?.walletAddress;
  if (!walletAddress) {
    return res.status(401).json({ error: "unauthorized" });
  }

  let conversation;
  try {
    conversation = await getOrCreateConversation(walletAddress);
  } catch (error) {
    logger.error("[support-chat] Failed to open stream", { error });
    return res.status(500).json({ error: "support_chat_unavailable" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  const unsubscribe = subscribeToSupportChat(conversation.id, (event) => {
    // Never echo the user's own events back to their own stream.
    if (event.type === "typing" && event.senderRole === "USER") return;
    if (event.type === "message" && event.message.senderRole === "USER") return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});
