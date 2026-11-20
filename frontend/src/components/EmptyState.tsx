"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React from "react";
import { Illustration, type IllustrationName } from "./illustrations/Illustration";

export interface EmptyStateAction {
  label: string;
  href?: string;
  onClick?: () => void;
}

export interface EmptyStateProps {
  /** Illustration slot. Defaults to a generic inbox icon. */
  icon?: React.ReactNode;
  /**
   * Theme-aware illustration to show above the copy. When set (or when no
   * `icon` is provided) the light/dark variant is chosen automatically from the
   * active `[data-theme]`, so empty states never show a light-background
   * artifact in dark mode.
   */
  illustration?: IllustrationName;
  title: string;
  message?: string;
  /** Primary call-to-action slot, routing the viewer to the relevant next step. */
  action?: EmptyStateAction;
  className?: string;
}

/**
 * Reusable contextual empty state: illustration + message + optional CTA.
 * Used in place of a blank table/list wherever a view has no data yet
 * (loan list, transaction history, notifications, admin queues, ...).
 */
export function EmptyState({
  icon,
  illustration,
  title,
  message,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={`flex flex-col items-center justify-center text-center rounded-2xl border border-dashed border-[var(--border-color)] bg-[var(--bg-card)]/40 px-6 py-12 ${className}`}
    >
      {illustration ? (
        <Illustration name={illustration} className="mb-4 w-full max-w-[180px]" />
      ) : icon ? (
        <div className="mb-4 rounded-full border border-[var(--accent-primary)]/20 bg-[var(--accent-primary)]/10 p-3 text-[var(--accent-primary-light)]">
          {icon}
        </div>
      ) : (
        <Illustration name="empty-states" className="mb-4 w-full max-w-[180px]" />
      )}
      <p className="text-sm font-semibold text-[var(--text-primary)]">{title}</p>
      {message && (
        <p className="mt-1 text-xs text-[var(--text-muted)] max-w-xs">{message}</p>
      )}
      {action && (
        action.href ? (
          <a href={action.href} className="btn-cta mt-5 !py-2 !px-4 text-xs">
            {action.label}
          </a>
        ) : (
          <button type="button" onClick={action.onClick} className="btn-cta mt-5 !py-2 !px-4 text-xs">
            {action.label}
          </button>
        )
      )}
    </div>
  );
}

export default EmptyState;
