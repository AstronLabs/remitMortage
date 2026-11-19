"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { Download, X } from "lucide-react";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";

/**
 * App-like install prompt. Mounted once in the root layout; it renders nothing
 * until the browser reports the app is installable and a short delay has
 * passed, and it stays gone once the user dismisses it in this browser.
 */
export function InstallPrompt() {
  const { visible, install, dismiss } = useInstallPrompt();

  if (!visible) return null;

  return (
    <section
      aria-label="Install app"
      data-testid="install-prompt"
      className="fixed bottom-4 left-4 z-40 flex w-full max-w-sm items-start gap-3 rounded-[var(--radius-md)] border border-[var(--border-color)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)]"
    >
      <Download
        size={20}
        className="mt-0.5 shrink-0 text-[var(--accent-primary)]"
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-[var(--text-primary)]">Install RemitMortgage</p>
        <p className="mt-0.5 break-words text-xs text-[var(--text-secondary)]">
          Add the app to your device for a faster, offline-ready experience.
        </p>
        <button
          type="button"
          onClick={install}
          data-testid="install-prompt-accept"
          className="mt-3 inline-flex min-h-[44px] items-center rounded-full bg-[var(--accent-primary)] px-4 text-sm font-semibold text-slate-950 transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] focus:ring-offset-2 focus:ring-offset-[var(--bg-card)]"
        >
          Install
        </button>
      </div>
      <button
        type="button"
        onClick={dismiss}
        data-testid="install-prompt-dismiss"
        aria-label="Dismiss install prompt"
        title="Dismiss"
        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </section>
  );
}

export default InstallPrompt;
