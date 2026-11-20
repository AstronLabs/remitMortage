"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef } from "react";
import { useNotifications } from "@/context/NotificationContext";

/** Default length of the undo window, in milliseconds. */
export const DEFAULT_UNDO_WINDOW_MS = 6000;

export interface UndoableAction {
  /** Toast title, e.g. "Removed from watchlist". */
  title: string;
  /** Optional supporting line shown under the title. */
  message?: string;
  /**
   * Applies the change for real once the undo window lapses. Omit it when the
   * effect is already applied optimistically and only needs reverting on undo.
   */
  commit?: () => void | Promise<void>;
  /** Reverses the optimistic change when the user taps Undo in the window. */
  revert: () => void;
}

/**
 * Runs a destructive action behind a short undo window.
 *
 * The caller applies the optimistic UI change immediately, then calls `run`
 * with a `revert` callback. If the user taps Undo before the window lapses the
 * change is reversed and `commit` is never invoked; otherwise `commit` runs so
 * the effect (typically a server call) only happens after the window passes.
 *
 * Pending actions are committed on unmount so navigating away never silently
 * drops a change the user made.
 */
export function useUndoableAction() {
  const { notify } = useNotifications();
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const tasks = useRef(new Map<string, UndoableAction>());

  const run = useCallback(
    (action: UndoableAction, windowMs: number = DEFAULT_UNDO_WINDOW_MS) => {
      const id = `undo-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const settle = () => {
        const timer = timers.current.get(id);
        if (timer) clearTimeout(timer);
        timers.current.delete(id);
        const task = tasks.current.get(id);
        tasks.current.delete(id);
        return task;
      };

      timers.current.set(
        id,
        setTimeout(() => {
          const task = settle();
          if (task?.commit) void task.commit();
        }, windowMs)
      );
      tasks.current.set(id, action);

      notify({
        id,
        variant: "info",
        title: action.title,
        message: action.message,
        duration: windowMs,
        transient: true,
        action: {
          label: "Undo",
          onAction: () => {
            const task = settle();
            if (task) task.revert();
          },
        },
      });

      return id;
    },
    [notify]
  );

  useEffect(() => {
    const pendingTimers = timers.current;
    const pendingTasks = tasks.current;
    return () => {
      pendingTimers.forEach((timer) => clearTimeout(timer));
      pendingTimers.clear();
      pendingTasks.forEach((task) => {
        if (task.commit) void task.commit();
      });
      pendingTasks.clear();
    };
  }, []);

  return { run };
}

export default useUndoableAction;
