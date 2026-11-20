// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * A short in-app note that tells existing users about a shipped feature.
 */
export interface FeatureAnnouncement {
  /**
   * Stable identifier used to remember dismissals. Never reuse an id for a
   * different announcement, or users who dismissed the old one will miss it.
   */
  id: string;
  title: string;
  message: string;
}

/**
 * The single source of truth for active announcements, newest first.
 *
 * Adding an announcement is a config-only change: append an entry here and it
 * is shown to every user who has not dismissed it yet — no page code changes.
 */
export const FEATURE_ANNOUNCEMENTS: FeatureAnnouncement[] = [
  {
    id: "undo-destructive-actions",
    title: "Undo for accidental clicks",
    message:
      "Removing a watchlist entry or dismissing a notification now gives you a few seconds to undo.",
  },
];
