"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";

export interface UseTypingIndicatorOptions {
  /**
   * Called whenever the local user's typing state changes (already
   * debounced) — wire this to whatever notifies the other party, e.g. a
   * `POST /api/support-chat/typing` call.
   */
  onLocalTypingChange?: (isTyping: boolean) => void;
  /** Inactivity delay after the last `notifyTyping()` call before a "stopped" change fires. Default 1500ms. */
  debounceMs?: number;
  /**
   * How long to keep showing the other party as typing if no fresh
   * "typing" event refreshes it — the fallback for a missed/lost "stopped
   * typing" signal. Default 5000ms.
   */
  remoteTimeoutMs?: number;
}

export interface UseTypingIndicatorResult {
  /** Call on every local keystroke/input change in the chat's text field. */
  notifyTyping: () => void;
  /** Whether the other party should currently be shown as typing. */
  isOtherPartyTyping: boolean;
  /**
   * Feed this from whatever realtime transport is in use (SSE, websocket,
   * polling) whenever a remote typing-state event arrives for this
   * conversation. This hook has no transport of its own, so if the
   * transport never connects or errors out, this is simply never called —
   * the indicator just never appears, which is the intended graceful
   * degradation.
   */
  receiveRemoteTypingEvent: (isTyping: boolean) => void;
}

/**
 * Tracks and debounces a chat's typing-indicator state, independent of
 * whatever realtime transport delivers the actual events.
 *
 * Local side: `notifyTyping()` is meant to be called on every keystroke. The
 * first call in a burst fires `onLocalTypingChange(true)` immediately;
 * further calls just extend the timer. Once `debounceMs` passes with no
 * further calls, `onLocalTypingChange(false)` fires — this is what keeps
 * outbound typing events infrequent instead of one per keystroke.
 *
 * Remote side: `receiveRemoteTypingEvent(true)` shows the indicator and
 * arms a `remoteTimeoutMs` timeout that auto-clears it. A missed "stopped
 * typing" event (dropped message, other party's tab closing uncleanly)
 * self-heals once that timeout elapses instead of leaving a stale
 * indicator forever. `receiveRemoteTypingEvent(false)` clears it
 * immediately.
 */
export function useTypingIndicator(
  options: UseTypingIndicatorOptions = {}
): UseTypingIndicatorResult {
  const { onLocalTypingChange, debounceMs = 1500, remoteTimeoutMs = 5000 } = options;

  const [isOtherPartyTyping, setIsOtherPartyTyping] = useState(false);
  const isLocalTypingRef = useRef(false);
  const localStopTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const remoteTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onLocalTypingChangeRef = useRef(onLocalTypingChange);

  useEffect(() => {
    onLocalTypingChangeRef.current = onLocalTypingChange;
  }, [onLocalTypingChange]);

  const notifyTyping = useCallback(() => {
    if (!isLocalTypingRef.current) {
      isLocalTypingRef.current = true;
      onLocalTypingChangeRef.current?.(true);
    }

    if (localStopTimeoutRef.current) {
      clearTimeout(localStopTimeoutRef.current);
    }
    localStopTimeoutRef.current = setTimeout(() => {
      isLocalTypingRef.current = false;
      onLocalTypingChangeRef.current?.(false);
    }, debounceMs);
  }, [debounceMs]);

  const clearRemoteTimeout = useCallback(() => {
    if (remoteTimeoutRef.current) {
      clearTimeout(remoteTimeoutRef.current);
      remoteTimeoutRef.current = undefined;
    }
  }, []);

  const receiveRemoteTypingEvent = useCallback(
    (isTyping: boolean) => {
      clearRemoteTimeout();
      setIsOtherPartyTyping(isTyping);
      if (isTyping) {
        remoteTimeoutRef.current = setTimeout(() => {
          setIsOtherPartyTyping(false);
        }, remoteTimeoutMs);
      }
    },
    [clearRemoteTimeout, remoteTimeoutMs]
  );

  // Unmount cleanup: cancel timers, and if the local user was still
  // "typing" at the moment of unmount, fire one final "stopped" so the
  // other party isn't left looking at a stale indicator.
  useEffect(() => {
    return () => {
      if (localStopTimeoutRef.current) clearTimeout(localStopTimeoutRef.current);
      clearRemoteTimeout();
      if (isLocalTypingRef.current) {
        onLocalTypingChangeRef.current?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { notifyTyping, isOtherPartyTyping, receiveRemoteTypingEvent };
}

export default useTypingIndicator;
