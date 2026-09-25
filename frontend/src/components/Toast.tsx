"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useState } from "react";
import { CheckCircle2, Info, AlertTriangle, XCircle, X, type LucideIcon } from "lucide-react";
import {
  useNotifications,
  type ToastNotification,
  type ToastVariant,
} from "@/context/NotificationContext";

type VariantStyle = {
  icon: LucideIcon;
  /** CSS color used for the icon, accent bar and progress bar. */
  color: string;
};

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  success: { icon: CheckCircle2, color: "var(--success)" },
  info: { icon: Info, color: "var(--accent-secondary)" },
  warning: { icon: AlertTriangle, color: "var(--warning)" },
  error: { icon: XCircle, color: "var(--error)" },
};

/**
 * A single toast notification. Auto-dismisses after `notification.duration`
 * milliseconds and renders a depleting progress bar for the same window.
 */
export function Toast({
  notification,
  onDismiss,
}: {
  notification: ToastNotification;
  onDismiss: (id: string) => void;
}) {
  const { id, variant, title, message, duration } = notification;
  const { icon: Icon, color } = VARIANT_STYLES[variant];
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => onDismiss(id), duration);
    return () => clearTimeout(timer);
  }, [id, duration, paused, onDismiss]);

  return (
    <div
      role="alert"
      aria-live="polite"
      className="animate-toast-in pointer-events-auto relative w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]"
      style={{ borderLeft: `3px solid ${color}` }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex items-start gap-3 p-4">
        <Icon size={20} style={{ color }} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
          {message ? (
            <p className="mt-0.5 break-words text-xs text-[var(--text-secondary)]">{message}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(id)}
          className="shrink-0 rounded text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <X size={16} />
        </button>
      </div>

      <div className="h-0.5 w-full bg-[var(--border-color)]">
        <div
          className="h-full origin-left"
          style={{
            backgroundColor: color,
            animation: `toast-progress ${duration}ms linear forwards`,
            animationPlayState: paused ? "paused" : "running",
          }}
        />
      </div>
    </div>
  );
}

/**
 * Fixed top-right container that renders the active notification stack. Mount
 * this once near the app root; it reads the queue from NotificationProvider.
 */
export function ToastContainer() {
  const { notifications, dismiss } = useNotifications();

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[1000] flex flex-col items-end gap-3">
      {notifications.map((notification) => (
        <Toast key={notification.id} notification={notification} onDismiss={dismiss} />
      ))}
    </div>
  );
}

export default Toast;
