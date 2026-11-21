"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearApplicationProgress,
  loadApplicationProgress,
  saveApplicationProgress,
  type LoadProgressResult,
  type SavedApplicationProgress,
} from "@/lib/applicationProgressApi";

interface ApplicationProgressSyncOptions {
  /** Signed-in wallet; nothing is loaded or saved without one. */
  address: string | null;
  step: number;
  totalSteps: number;
  /** Reads the current form values at save time. */
  getData: () => Record<string, unknown>;
  /** Applies saved values and step back onto the wizard. */
  onResume: (progress: SavedApplicationProgress) => void;
}

export type ProgressSyncStatus =
  "idle" | "loading" | "resume-available" | "sign-in-required" | "synced" | "offline";

/**
 * Keeps a multi-step application's progress on the backend (issue #1110).
 *
 * On sign-in it looks for a save point; if one exists the applicant is offered
 * to resume it. Once that choice is made (or there was nothing to resume) every
 * step change is saved, so closing the app at any point loses nothing and the
 * application can be picked up on another device. Saving is held back until
 * the load settles so a fresh device starting at step 1 never overwrites
 * progress made elsewhere.
 */
export function useApplicationProgressSync({
  address,
  step,
  totalSteps,
  getData,
  onResume,
}: ApplicationProgressSyncOptions) {
  const [status, setStatus] = useState<ProgressSyncStatus>("idle");
  const [savedProgress, setSavedProgress] = useState<SavedApplicationProgress | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const getDataRef = useRef(getData);
  const onResumeRef = useRef(onResume);
  useEffect(() => {
    getDataRef.current = getData;
    onResumeRef.current = onResume;
  }, [getData, onResume]);

  // Which wallet `status` describes; anything else is still loading.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  const applyLoadResult = useCallback((wallet: string, result: LoadProgressResult) => {
    setLoadedFor(wallet);
    switch (result.status) {
      case "found":
        setSavedProgress(result.progress);
        setStatus("resume-available");
        break;
      case "none":
        setSavedProgress(null);
        setStatus("synced");
        break;
      case "unauthenticated":
        setStatus("sign-in-required");
        break;
      default:
        setStatus("offline");
    }
  }, []);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    void loadApplicationProgress().then((result) => {
      if (!cancelled) applyLoadResult(address, result);
    });
    return () => {
      cancelled = true;
    };
  }, [address, applyLoadResult]);

  /** Loads again, e.g. after the applicant signs in. */
  const reload = useCallback(async () => {
    if (!address) return;
    setLoadedFor(null);
    applyLoadResult(address, await loadApplicationProgress());
  }, [address, applyLoadResult]);

  const effectiveStatus: ProgressSyncStatus = !address
    ? "idle"
    : loadedFor === address
      ? status
      : "loading";

  const save = useCallback(async () => {
    const ok = await saveApplicationProgress({ step, totalSteps, data: getDataRef.current() });
    if (ok) setLastSavedAt(new Date().toISOString());
    return ok;
  }, [step, totalSteps]);

  // Persist on every step change once the load has settled.
  useEffect(() => {
    if (effectiveStatus !== "synced") return;
    void save();
  }, [effectiveStatus, save]);

  const resume = useCallback(() => {
    if (!savedProgress) return;
    onResumeRef.current(savedProgress);
    setSavedProgress(null);
    setStatus("synced");
  }, [savedProgress]);

  /** Start over: the next save replaces the old save point. */
  const startOver = useCallback(() => {
    setSavedProgress(null);
    setStatus("synced");
  }, []);

  const clear = useCallback(async () => {
    await clearApplicationProgress();
    setLastSavedAt(null);
  }, []);

  return {
    status: effectiveStatus,
    savedProgress: effectiveStatus === "resume-available" ? savedProgress : null,
    lastSavedAt,
    resume,
    startOver,
    reload,
    clear,
  };
}
