"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from "react";
import { FEATURE_ANNOUNCEMENTS, type FeatureAnnouncement } from "@/lib/featureAnnouncements";

/** localStorage key holding the ids this user has already dismissed. */
export const DISMISSED_ANNOUNCEMENTS_KEY = "rm.dismissed-feature-announcements";

function readDismissedIds(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_ANNOUNCEMENTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    // Corrupt JSON or storage unavailable: treat as nothing dismissed.
    return [];
  }
}

function writeDismissedIds(ids: string[]) {
  try {
    window.localStorage.setItem(DISMISSED_ANNOUNCEMENTS_KEY, JSON.stringify(ids));
  } catch {
    /* storage unavailable: dismissal lasts for this session only */
  }
}

export interface UseFeatureAnnouncementsResult {
  /** Announcements in the config that this user has not dismissed. */
  announcements: FeatureAnnouncement[];
  /** Dismiss one announcement forever (for this user). */
  dismiss: (id: string) => void;
  /** False during the first paint, before dismissals are read from storage. */
  hydrated: boolean;
}

/**
 * Resolves the active feature announcements against the ids this user has
 * dismissed in localStorage. Dismissals are read after mount so the server
 * render and first client paint agree.
 */
export function useFeatureAnnouncements(): UseFeatureAnnouncementsResult {
  const [dismissedIds, setDismissedIds] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setDismissedIds(readDismissedIds());
    setHydrated(true);
  }, []);

  const dismiss = useCallback((id: string) => {
    setDismissedIds((current) => {
      if (current.includes(id)) return current;
      const next = [...current, id];
      writeDismissedIds(next);
      return next;
    });
  }, []);

  return {
    announcements: FEATURE_ANNOUNCEMENTS.filter((item) => !dismissedIds.includes(item.id)),
    dismiss,
    hydrated,
  };
}

export default useFeatureAnnouncements;
