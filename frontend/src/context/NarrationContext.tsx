"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import {
  DEFAULT_NARRATION_RATE,
  type NarrationEngine,
  type NarrationRate,
  type NarrationSegment,
  type NarrationState,
  type NarrationStatus,
  collectNarrationSegments,
  createNarrationEngine,
  isSpeechSynthesisSupported,
} from "@/lib/loanTermsNarration";

/** localStorage key holding the opt-in preference and chosen speed. */
const STORAGE_KEY = "loan-terms-narration";

interface NarrationSettings {
  /** The user's opt-in. Narration never starts while this is false. */
  enabled: boolean;
  /** Playback speed to resume with. */
  rate: NarrationRate;
  /** Whether this browser exposes a usable Web Speech API. */
  supported: boolean;
}

const SERVER_SETTINGS: NarrationSettings = {
  enabled: false,
  rate: DEFAULT_NARRATION_RATE,
  supported: false,
};

/**
 * The persisted preference is modelled as an external store rather than
 * component state.
 *
 * `useSyncExternalStore` is what lets the opt-in be read during the very first
 * client render without a hydration mismatch: the server snapshot is
 * deterministic and opted-out, and React swaps in the real value once it can
 * see `localStorage`. It also avoids a `setState`-in-effect, which would cost
 * an extra render pass on every page load.
 */
const preferenceListeners = new Set<() => void>();

/**
 * Cached so the snapshot is referentially stable between reads, as
 * `useSyncExternalStore` requires. The cache key includes the raw stored value
 * and the current speech support, so a change made outside `persistSettings`
 * (another tab, devtools, a test resetting storage) is picked up rather than
 * serving a stale opt-in.
 */
let cachedSettings: { key: string; settings: NarrationSettings } | null = null;

function emitPreferenceChange() {
  for (const listener of preferenceListeners) listener();
}

function subscribeToPreference(onStoreChange: () => void): () => void {
  preferenceListeners.add(onStoreChange);
  // Keeps other tabs in sync when the preference changes here.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      onStoreChange();
    }
  };
  window.addEventListener("storage", onStorage);

  return () => {
    preferenceListeners.delete(onStoreChange);
    window.removeEventListener("storage", onStorage);
  };
}

function readStoredPreference(): { enabled: boolean; rate: NarrationRate } {
  let enabled = false;
  let rate: NarrationRate = DEFAULT_NARRATION_RATE;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<{ enabled: boolean; rate: number }>;
      enabled = parsed.enabled === true;
      if (typeof parsed.rate === "number") rate = parsed.rate as NarrationRate;
    }
  } catch {
    // A blocked or corrupt value must not break the page: fall back to the
    // opt-out default. The feature simply stays off.
  }

  return { enabled, rate };
}

function currentCacheKey(): string {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  return `${raw ?? ""}|${isSpeechSynthesisSupported()}`;
}

function getSettingsSnapshot(): NarrationSettings {
  const key = currentCacheKey();
  if (cachedSettings && cachedSettings.key === key) return cachedSettings.settings;

  const stored = readStoredPreference();
  const settings: NarrationSettings = { ...stored, supported: isSpeechSynthesisSupported() };
  cachedSettings = { key, settings };
  return settings;
}

/** Deterministic during SSR, so the first client render cannot disagree. */
function getServerSettingsSnapshot(): NarrationSettings {
  return SERVER_SETTINGS;
}

function persistSettings(next: { enabled?: boolean; rate?: NarrationRate }) {
  const stored = readStoredPreference();
  const enabled = next.enabled ?? stored.enabled;
  const rate = next.rate ?? stored.rate;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled, rate }));
  } catch {
    // Best-effort: narration still works for this session even if the
    // browser refuses to persist (private mode, storage quota).
  }

  // The cache is keyed on what is actually stored, so it is safe to leave the
  // invalidation to the next snapshot read.
  emitPreferenceChange();
}

type NarrationContextValue = NarrationState & {
  /** True when the platform exposes a usable Web Speech API. */
  supported: boolean;
  /** The user's opt-in. Narration never starts while this is false. */
  enabled: boolean;
  /** Flips the opt-in. Switching on reveals the playback controls. */
  setEnabled: (enabled: boolean) => void;
  /** Re-reads `data-narration` from the subtree and narrates from the start. */
  narrateNow: () => void;
  play: () => void;
  pause: () => void;
  resume: () => void;
  /** Re-speak only the term currently being narrated. */
  replay: () => void;
  restart: () => void;
  stop: () => void;
  setRate: (rate: NarrationRate) => void;
  cycleRate: () => void;
};

const NarrationContext = createContext<NarrationContextValue | undefined>(undefined);

const INITIAL_PLAYBACK: NarrationState = {
  status: "idle",
  index: 0,
  total: 0,
  rate: DEFAULT_NARRATION_RATE,
};

/**
 * Provides opt-in speech narration of marked-up loan terms.
 *
 * The provider owns the playback engine and mirrors its state into React so
 * the controls re-render as terms advance.
 *
 * Note that restoring a previously-enabled preference does *not* start speech
 * by itself: narrating unprompted on every page load would be hostile to
 * screen-reader and low-literacy users. The controls appear ready to play.
 */
export function NarrationProvider({
  children,
  targetRef,
  engine: injectedEngine,
}: {
  children: React.ReactNode;
  /** Subtree scanned for `data-narration` terms. Defaults to `document.body`. */
  targetRef?: React.RefObject<HTMLElement | null>;
  /** Test seam: inject a fake engine. */
  engine?: NarrationEngine;
}) {
  const settings = useSyncExternalStore(
    subscribeToPreference,
    getSettingsSnapshot,
    getServerSettingsSnapshot
  );

  const [playback, setPlayback] = useState<NarrationState>(INITIAL_PLAYBACK);

  // Created once, lazily: the engine holds a live reference to the speech
  // synthesis object, so rebuilding it on a re-render would drop playback.
  const [engine] = useState<NarrationEngine>(
    () => injectedEngine ?? createNarrationEngine({ onStateChange: setPlayback })
  );

  const gatherSegments = useCallback((): NarrationSegment[] => {
    // Scans `document.body` by default rather than wrapping `children` in an
    // extra element: inserting a node into an existing layout risks perturbing
    // grid/flex positioning across the whole app.
    const root = targetRef?.current ?? (typeof document !== "undefined" ? document.body : null);
    if (!root) return [];
    return collectNarrationSegments(root);
  }, [targetRef]);

  const narrateNow = useCallback(() => {
    const segments = gatherSegments();
    engine.load(segments);
    if (segments.length) engine.play();
  }, [engine, gatherSegments]);

  /**
   * Play always (re)reads the marked-up terms first.
   *
   * The terms are collected on demand rather than held from mount: the DOM
   * around a loan card changes as data loads, and the user pressing Play means
   * "read what is on screen now". Loading is idempotent, so pressing Play
   * twice simply restarts the run.
   */
  const play = useCallback(() => {
    const segments = gatherSegments();
    engine.load(segments);
    if (segments.length) engine.play();
  }, [engine, gatherSegments]);

  const setEnabled = useCallback(
    (next: boolean) => {
      persistSettings({ enabled: next });
      // Switching off must silence speech immediately; switching on only
      // reveals the controls, it does not speak unprompted.
      if (!next) engine.stop();
    },
    [engine]
  );

  const setRate = useCallback(
    (rate: NarrationRate) => {
      engine.setRate(rate);
      persistSettings({ rate });
    },
    [engine]
  );

  const value = useMemo<NarrationContextValue>(
    () => ({
      ...playback,
      // The chosen speed is authoritative; playback state carries the default.
      rate: settings.rate,
      supported: settings.supported,
      enabled: settings.enabled,
      setEnabled,
      narrateNow,
      play,
      restart: play,
      pause: () => engine.pause(),
      resume: () => engine.resume(),
      replay: () => engine.replayCurrent(),
      stop: () => engine.stop(),
      setRate,
      cycleRate: () => {
        const next = engine.cycleRate();
        persistSettings({ rate: next });
      },
    }),
    [
      playback,
      settings.rate,
      settings.supported,
      settings.enabled,
      setEnabled,
      narrateNow,
      play,
      engine,
      setRate,
    ]
  );

  return <NarrationContext.Provider value={value}>{children}</NarrationContext.Provider>;
}

export function useNarration(): NarrationContextValue {
  const context = useContext(NarrationContext);
  if (!context) {
    throw new Error("useNarration must be used within NarrationProvider");
  }
  return context;
}

export type { NarrationStatus };
