"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Sparkles, X } from "lucide-react";
import { useFeatureAnnouncements } from "@/hooks/useFeatureAnnouncements";

/**
 * Shows the active feature announcements, each individually dismissible.
 *
 * Mounted once in the root layout; the list itself lives in
 * `lib/featureAnnouncements.ts`, so shipping a new announcement is a config-only
 * change. Dismissals are remembered per user, so a dismissed announcement never
 * shows again.
 */
export function FeatureAnnouncements() {
  const { announcements, dismiss, hydrated } = useFeatureAnnouncements();

  if (!hydrated || announcements.length === 0) return null;

  return (
    <section
      aria-label="Feature announcements"
      data-testid="feature-announcements"
      className="fixed bottom-4 right-4 z-40 flex w-full max-w-sm flex-col gap-2"
    >
      {announcements.map((announcement) => (
        <div
          key={announcement.id}
          data-testid={`feature-announcement-${announcement.id}`}
          className="pointer-events-auto flex items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)]"
        >
          <Sparkles
            size={20}
            className="mt-0.5 shrink-0 text-[var(--accent-secondary)]"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--text-primary)]">{announcement.title}</p>
            <p className="mt-0.5 break-words text-xs text-[var(--text-secondary)]">
              {announcement.message}
            </p>
          </div>
          <button
            type="button"
            onClick={() => dismiss(announcement.id)}
            data-testid={`dismiss-announcement-${announcement.id}`}
            aria-label={`Dismiss announcement: ${announcement.title}`}
            title="Dismiss"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
    </section>
  );
}

export default FeatureAnnouncements;
