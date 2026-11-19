"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from "react";

/** localStorage key marking that this browser has dismissed the prompt. */
export const INSTALL_PROMPT_DISMISSED_KEY = "rm.install-prompt-dismissed";

/** How long to wait after the app becomes installable before prompting. */
export const DEFAULT_INSTALL_PROMPT_DELAY_MS = 15000;

/**
 * The `beforeinstallprompt` event isn't in the DOM lib typings, so this is the
 * minimal shape we rely on.
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt: () => Promise<void>;
}

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(INSTALL_PROMPT_DISMISSED_KEY) === "1";
  } catch {
    // Storage unavailable: treat as not dismissed for this session.
    return false;
  }
}

function writeDismissed() {
  try {
    window.localStorage.setItem(INSTALL_PROMPT_DISMISSED_KEY, "1");
  } catch {
    /* storage unavailable: dismissal lasts for this session only */
  }
}

export interface UseInstallPromptOptions {
  /** Delay between the app becoming installable and the prompt appearing. */
  delayMs?: number;
}

export interface UseInstallPromptResult {
  /** True once the prompt should be shown. */
  visible: boolean;
  /** False during the first paint, before storage is read. */
  hydrated: boolean;
  /** Trigger the browser's native install flow. */
  install: () => Promise<void>;
  /** Dismiss the prompt forever (for this browser). */
  dismiss: () => void;
}

/**
 * Captures the browser's deferred `beforeinstallprompt` event and decides when
 * the custom install prompt may appear. The prompt is only offered a moment
 * after the browser reports the app is installable (never on arrival) and only
 * if this browser hasn't already dismissed it.
 */
export function useInstallPrompt({
  delayMs = DEFAULT_INSTALL_PROMPT_DELAY_MS,
}: UseInstallPromptOptions = {}): UseInstallPromptResult {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [eligible, setEligible] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Read the persisted dismissal after mount so server and client agree.
  useEffect(() => {
    setDismissed(readDismissed());
    setHydrated(true);
  }, []);

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      // Stop Chromium's own mini-infobar; we present our own UI instead.
      event.preventDefault();
      setEligible(false);
      setDeferredPrompt(event as BeforeInstallPromptEvent);
    };
    const onAppInstalled = () => {
      setInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  // Hold the prompt back briefly so it never greets a user the instant they
  // land on the page.
  useEffect(() => {
    if (!hydrated || dismissed || installed || !deferredPrompt) return;
    const timer = window.setTimeout(() => setEligible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [hydrated, dismissed, installed, deferredPrompt, delayMs]);

  const dismiss = useCallback(() => {
    writeDismissed();
    setDismissed(true);
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    if (outcome === "accepted") setInstalled(true);
  }, [deferredPrompt]);

  return {
    visible: hydrated && !dismissed && !installed && eligible && deferredPrompt !== null,
    hydrated,
    install,
    dismiss,
  };
}

export default useInstallPrompt;
