"use client";

import React, { useEffect, useState } from "react";
import { useToast, type ToastMessage, type ToastVariant } from "@/context/ToastContext";

/* ── SVG Iconography per variant ───────────────────────────────────── */

const ICONS: Record<ToastVariant, React.ReactNode> = {
  success: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  ),
  info: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  ),
  warning: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  error: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      <circle cx="12" cy="12" r="10" />
      <path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  ),
};

const VARIANT_COLORS: Record<ToastVariant, string> = {
  success: "var(--success)",
  info: "var(--accent-secondary)",
  warning: "var(--warning)",
  error: "var(--error)",
};

/* ── Single Toast ──────────────────────────────────────────────────── */

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: ToastMessage;
  onDismiss: (id: string) => void;
}) {
  const { id, variant, title, message, duration } = toast;
  const color = VARIANT_COLORS[variant];
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
        <span style={{ color }} className="mt-0.5 shrink-0">
          {ICONS[variant]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
          {message ? (
            <p className="mt-0.5 break-words text-xs text-[var(--text-secondary)]">
              {message}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(id)}
          className="shrink-0 rounded text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Progress bar */}
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

/* ── Container ─────────────────────────────────────────────────────── */

/**
 * Fixed top-right container that renders the active toast stack.
 * Mount once near the app root inside ToastProvider.
 */
export function ToastContainer() {
  const { toasts, dismiss } = useToast();

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[1000] flex flex-col items-end gap-3">
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}

export default ToastContainer;
