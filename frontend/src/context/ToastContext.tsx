"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  /** Auto-dismiss delay in ms. Defaults to 4000. */
  duration: number;
}

export type ToastInput = Omit<ToastMessage, "id" | "duration"> & {
  id?: string;
  duration?: number;
};

type ToastContextType = {
  toasts: ToastMessage[];
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const DEFAULT_DURATION_MS = 4000;
const MAX_VISIBLE = 4;

/**
 * ToastProvider — a lightweight, non-blocking toast engine built on React hooks.
 * Manages a queue of ToastMessage objects with auto-dismiss and a configurable
 * default duration of 4 seconds.
 */
export function ToastProvider({
  children,
  defaultDuration,
}: {
  children: React.ReactNode;
  defaultDuration?: number;
}) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);
  const counter = useRef(0);
  const resolvedDefault = defaultDuration ?? DEFAULT_DURATION_MS;

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      counter.current += 1;
      const id = input.id ?? `toast-${counter.current}`;
      const msg: ToastMessage = {
        id,
        variant: input.variant,
        title: input.title,
        message: input.message,
        duration: input.duration ?? resolvedDefault,
      };

      setToasts((prev) => {
        const withoutDup = prev.filter((t) => t.id !== id);
        return [...withoutDup, msg].slice(-MAX_VISIBLE);
      });

      return id;
    },
    [resolvedDefault]
  );

  const value = useMemo(() => ({ toasts, toast, dismiss }), [toasts, toast, dismiss]);

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

export function OptionalToastProvider({ children }: { children: React.ReactNode }) {
  const ctx = useContext(ToastContext);
  if (ctx) {
    return <>{children}</>;
  }
  return <ToastProvider>{children}</ToastProvider>;
}

export default ToastContext;
