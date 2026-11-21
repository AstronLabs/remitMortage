"use client";

import { useEffect, useState } from "react";
import {
  detectBrowserTimezone,
  timezoneLabel,
  timezoneStorageKey,
  type DisplayTimezone,
} from "@/lib/timezone";

export default function TimezoneSettings({ userId = "anonymous" }: { userId?: string }) {
  const [mode, setMode] = useState<DisplayTimezone>("local");
  const [browserTimezone, setBrowserTimezone] = useState("UTC");

  useEffect(() => {
    setBrowserTimezone(detectBrowserTimezone());
    const saved = window.localStorage.getItem(timezoneStorageKey(userId));
    if (saved === "UTC" || saved === "local") setMode(saved);
  }, [userId]);

  function updateMode(next: DisplayTimezone) {
    setMode(next);
    window.localStorage.setItem(timezoneStorageKey(userId), next);
  }

  return (
    <section aria-labelledby="timezone-settings-title" className="rounded-xl border border-[var(--border-color)] p-5">
      <h2 id="timezone-settings-title" className="text-lg font-semibold">Timestamp timezone</h2>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        Timestamps show your browser timezone by default ({browserTimezone}) and are labelled wherever displayed.
      </p>
      <div className="mt-4 flex items-center gap-3">
        <button type="button" aria-pressed={mode === "UTC"} onClick={() => updateMode(mode === "UTC" ? "local" : "UTC")}
          className="rounded-lg border border-[var(--border-color)] px-3 py-2 text-sm">
          {mode === "UTC" ? "Use browser timezone" : "Show timestamps in UTC"}
        </button>
        <span aria-live="polite" className="text-sm text-[var(--text-secondary)]">
          Active: {timezoneLabel(mode)}
        </span>
      </div>
    </section>
  );
}
