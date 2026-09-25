"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect } from "react";
import { useWalletExtension } from "@/hooks/useWalletExtension";

const DISMISSED_KEY = "wallet-banner-dismissed";

function isDismissed(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(DISMISSED_KEY) === "true";
}

function markDismissed() {
  try {
    localStorage.setItem(DISMISSED_KEY, "true");
  } catch {
    /* storage unavailable */
  }
}

export default function WalletBanner() {
  const { hasExtension } = useWalletExtension();
  const [dismissed, setDismissed] = useState(isDismissed);

  useEffect(() => {
    if (hasExtension === true) {
      setDismissed(false);
      try {
        localStorage.removeItem(DISMISSED_KEY);
      } catch {
        /* storage unavailable */
      }
    }
  }, [hasExtension]);

  if (hasExtension !== false || dismissed) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 bg-gradient-to-r from-amber-600 to-orange-600 text-white shadow-xl"
      role="alert"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          <span className="inline-flex items-center gap-1.5 text-sm font-bold uppercase tracking-wider">
            <svg
              className="h-5 w-5 shrink-0"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
              />
            </svg>
            Wallet Extension Required
          </span>
          <span className="text-sm text-amber-100">
            Install the{" "}
            <a
              href="https://chrome.google.com/webstore/detail/freighter/bcacfldlkkdogcmkkibnjlakofdplcbk"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-white"
            >
              Freighter
            </a>{" "}
            browser extension to connect your Stellar wallet and use this
            application.
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg bg-white/20 px-3 py-1.5 text-xs font-semibold hover:bg-white/30 transition-colors"
          >
            Install Guide
          </a>
          <button
            onClick={() => {
              markDismissed();
              setDismissed(true);
            }}
            className="rounded-lg p-1.5 text-amber-200 hover:text-white transition-colors"
            aria-label="Dismiss"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
