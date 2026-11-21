"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "./WalletContext";
import { announceToast } from "@/lib/announcer";

export type ToastVariant = "success" | "info" | "warning" | "error";

/**
 * An optional inline action rendered inside a toast (e.g. "Undo"), letting the
 * user reverse a low-stakes destructive action before its window lapses.
 */
export interface ToastAction {
  /** Button label, e.g. "Undo". */
  label: string;
  /** Invoked when the user activates the action. */
  onAction: () => void;
}

export interface ToastNotification {
  id: string;
  variant: ToastVariant;
  title: string;
  /** Optional secondary line rendered under the title. */
  message?: string;
  /** Auto-dismiss delay in milliseconds. Defaults to 5000. */
  duration: number;
  /** Optional inline action (e.g. an "Undo" button). */
  action?: ToastAction;
}

export interface NotificationRecord extends ToastNotification {
  read: boolean;
  createdAt: number;
}

/** Input accepted by {@link NotificationContextType.notify}. */
export type ToastInput = Omit<ToastNotification, "id" | "duration"> & {
  id?: string;
  duration?: number;
  /**
   * When true the toast is pure UI feedback: it is neither appended to the
   * notification inbox nor persisted to the backend. Used for transient
   * affordances such as an undo window.
   */
  transient?: boolean;
};

type NotificationContextType = {
  notifications: ToastNotification[];
  notificationHistory: NotificationRecord[];
  unreadCount: number;
  isPanelOpen: boolean;
  notify: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearHistory: () => void;
  /** Remove a single notification from the inbox history. */
  removeNotification: (id: string) => void;
  /** Re-insert previously removed notifications, keeping chronological order. */
  restoreNotifications: (records: NotificationRecord[]) => void;
};

const NotificationContext = createContext<NotificationContextType | undefined>(undefined);

const DEFAULT_DURATION_MS = 5000;
/** Maximum number of toasts shown at once; older ones drop off the stack. */
const MAX_VISIBLE = 3;
const MAX_HISTORY = 50;

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { publicKey } = useWallet();
  const [notifications, setNotifications] = useState<ToastNotification[]>([]);
  const [notificationHistory, setNotificationHistory] = useState<NotificationRecord[]>([]);
  const [isPanelOpen, setPanelOpen] = useState(false);
  const counter = useRef(0);

  // Fetch persistent notifications from backend when wallet connects
  const fetchBackendNotifications = useCallback(async (address: string) => {
    try {
      const res = await fetch(`${API_BASE}/api/notifications?address=${encodeURIComponent(address)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.notifications)) {
        const fetched: NotificationRecord[] = data.notifications.map((item: any) => ({
          id: item.id,
          variant: (item.variant as ToastVariant) || "info",
          title: item.title,
          message: item.message || undefined,
          duration: DEFAULT_DURATION_MS,
          read: Boolean(item.read),
          createdAt: new Date(item.createdAt).getTime(),
        }));

        setNotificationHistory((prev) => {
          // Merge remote with local history, avoiding duplicate IDs
          const existingIds = new Set(fetched.map((n) => n.id));
          const localOnly = prev.filter((n) => !existingIds.has(n.id));
          const combined = [...fetched, ...localOnly].sort((a, b) => a.createdAt - b.createdAt);
          return combined.slice(-MAX_HISTORY);
        });
      }
    } catch (err) {
      console.warn("Could not fetch remote notifications:", err);
    }
  }, []);

  useEffect(() => {
    if (publicKey) {
      fetchBackendNotifications(publicKey);
    }
  }, [publicKey, fetchBackendNotifications]);

  const dismiss = useCallback((id: string) => {
    setNotifications((current) => current.filter((n) => n.id !== id));
  }, []);

  const markRead = useCallback(
    async (id: string) => {
      setNotificationHistory((current) =>
        current.map((item) => (item.id === id ? { ...item, read: true } : item))
      );

      if (publicKey) {
        try {
          await fetch(`${API_BASE}/api/notifications/${id}/read`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address: publicKey }),
          });
        } catch (err) {
          console.warn("Failed to persist notification read state:", err);
        }
      }
    },
    [publicKey]
  );

  const markAllRead = useCallback(async () => {
    setNotificationHistory((current) => current.map((item) => ({ ...item, read: true })));

    if (publicKey) {
      try {
        await fetch(`${API_BASE}/api/notifications/read-all`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: publicKey }),
        });
      } catch (err) {
        console.warn("Failed to persist mark-all-read state:", err);
      }
    }
  }, [publicKey]);

  const clearHistory = useCallback(() => {
    setNotificationHistory([]);
  }, []);

  const removeNotification = useCallback((id: string) => {
    setNotificationHistory((current) => current.filter((item) => item.id !== id));
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const restoreNotifications = useCallback((records: NotificationRecord[]) => {
    if (records.length === 0) return;
    setNotificationHistory((current) => {
      const existingIds = new Set(current.map((item) => item.id));
      const restored = records.filter((item) => !existingIds.has(item.id));
      if (restored.length === 0) return current;
      return [...current, ...restored]
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-MAX_HISTORY);
    });
  }, []);

  const openPanel = useCallback(() => {
    setPanelOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    setPanelOpen(false);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpen((current) => !current);
  }, []);

  const notify = useCallback(
    (input: ToastInput) => {
      counter.current += 1;
      const id = input.id ?? `toast-${counter.current}-${Date.now()}`;
      const toast: ToastNotification = {
        id,
        variant: input.variant,
        title: input.title,
        message: input.message,
        duration: input.duration ?? DEFAULT_DURATION_MS,
        action: input.action,
      };

      announceToast(toast.variant, toast.title, toast.message);

      setNotifications((current) => {
        const withoutDup = current.filter((n) => n.id !== id);
        return [...withoutDup, toast].slice(-MAX_VISIBLE);
      });

      // Transient toasts (e.g. an undo window) are UI-only: they must not
      // clutter the notification inbox or hit the backend.
      if (input.transient) {
        return id;
      }

      const newRecord: NotificationRecord = {
        ...toast,
        createdAt: Date.now(),
        read: isPanelOpen,
      };

      setNotificationHistory((current) => [...current, newRecord].slice(-MAX_HISTORY));

      // Persist to backend if connected
      if (publicKey) {
        fetch(`${API_BASE}/api/notifications/in-app`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            address: publicKey,
            title: input.title,
            message: input.message,
            variant: input.variant,
          }),
        }).catch((err) => console.warn("Failed to persist in-app notification:", err));
      }

      return id;
    },
    [isPanelOpen, publicKey]
  );

  const unreadCount = useMemo(
    () => notificationHistory.filter((item) => !item.read).length,
    [notificationHistory]
  );

  const value = useMemo(
    () => ({
      notifications,
      notificationHistory,
      unreadCount,
      isPanelOpen,
      notify,
      dismiss,
      openPanel,
      closePanel,
      togglePanel,
      markRead,
      markAllRead,
      clearHistory,
      removeNotification,
      restoreNotifications,
    }),
    [
      notifications,
      notificationHistory,
      unreadCount,
      isPanelOpen,
      notify,
      dismiss,
      openPanel,
      closePanel,
      togglePanel,
      markRead,
      markAllRead,
      clearHistory,
      removeNotification,
      restoreNotifications,
    ]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error("useNotifications must be used within NotificationProvider");
  }
  return ctx;
}

export default NotificationContext;
