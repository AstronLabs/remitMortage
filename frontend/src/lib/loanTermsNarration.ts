// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Speech-synthesis narration for loan terms.
 *
 * Accessibility feature: an opt-in mode that reads the critical terms of a
 * loan (principal, rate, term length, penalties) aloud using the Web Speech
 * Synthesis API, so the information is reachable without reading the screen.
 *
 * The engine is deliberately framework-agnostic — no React imports — so the
 * queueing, ordering and playback semantics can be unit tested in isolation.
 * `src/context/NarrationContext.tsx` is the thin React binding.
 *
 * ## How terms are discovered
 *
 * Components opt individual terms in declaratively by tagging the rendered
 * element with a `data-narration` attribute holding a spoken-friendly
 * summary:
 *
 * ```tsx
 * <div data-narration="Principal: 25,000 USDC">Principal: <strong>25,000 USDC</strong></div>
 * ```
 *
 * Reading order is DOM order, which is also the order a sighted user would
 * encounter the terms, so the spoken sequence is inherently "logical" —
 * there is no separate priority table to keep in sync with the markup.
 * `data-narration-order` is available for the rare case where visual layout
 * (CSS grid/flex reordering) makes DOM order differ from reading order.
 */

/** Attribute marking an element as a narratable loan term. */
export const NARRATION_ATTRIBUTE = "data-narration";

/** Optional attribute pinning narration order when layout reorders terms. */
export const NARRATION_ORDER_ATTRIBUTE = "data-narration-order";

/** Playback speeds offered to the user, as `SpeechSynthesisUtterance.rate` values. */
export const NARRATION_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export type NarrationRate = (typeof NARRATION_RATES)[number];

export const DEFAULT_NARRATION_RATE: NarrationRate = 1;

/** One narratable term. */
export interface NarrationSegment {
  /** The spoken summary, as authored on the element's `data-narration`. */
  text: string;
  /** Lower numbers are spoken first. Falls back to DOM position. */
  order: number;
  /** DOM position, retained as the stable tiebreaker for equal `order`. */
  position: number;
}

export type NarrationStatus = "idle" | "speaking" | "paused" | "done";

/**
 * The slice of the Web Speech API this module depends on. Declared
 * structurally so tests can supply a fake and jsdom (which ships no
 * `speechSynthesis`) does not need to.
 */
export interface SpeechSynthesisLike {
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
  pause(): void;
  resume(): void;
  speaking: boolean;
  paused: boolean;
}

/** The slice of `SpeechSynthesisUtterance` this module relies on. */
export interface SpeechSynthesisUtteranceLike {
  text: string;
  rate: number;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

/** Minimal `SpeechSynthesisUtterance` constructor shape, for injection. */
export type UtteranceFactory = (text: string) => SpeechSynthesisUtteranceLike;

/** Options accepted by {@link createNarrationEngine}. */
export interface NarrationEngineOptions {
  /** Existing speech synthesis implementation. Defaults to `window.speechSynthesis`. */
  synth?: SpeechSynthesisLike | null;
  /** Utterance constructor. Defaults to `window.SpeechSynthesisUtterance`. */
  createUtterance?: UtteranceFactory;
  /** Voice to prefer. Ignored when the platform reports no voices. */
  voice?: SpeechSynthesisVoice | null;
  /** Initial playback speed. */
  rate?: NarrationRate;
  /** Notified whenever playback state changes. */
  onStateChange?: (state: NarrationState) => void;
}

/** Observable playback state, also what the context re-renders from. */
export interface NarrationState {
  status: NarrationStatus;
  /** 0-based index of the segment being spoken. */
  index: number;
  /** Total segments in the current run. */
  total: number;
  rate: NarrationRate;
}

export interface NarrationEngine {
  /** Loads a new set of segments and starts from the beginning. */
  load(segments: NarrationSegment[]): void;
  /** Speaks the loaded segments from the start, replacing any current run. */
  play(): void;
  /** Pauses mid-sentence without losing position. */
  pause(): void;
  /** Resumes a paused run from where it stopped. */
  resume(): void;
  /**
   * Replays the current segment from its beginning without disturbing the
   * segments already spoken. The headline playback control: a user who
   * missed a figure wants to hear that figure again, not be thrown back to
   * the first term.
   */
  replayCurrent(): void;
  /** Returns to the first segment and plays it. */
  restart(): void;
  /** Stops playback and discards the loaded segments. */
  stop(): void;
  /** Changes speed. Takes effect on the next segment without interrupting. */
  setRate(rate: NarrationRate): void;
  /** Cycles forward through {@link NARRATION_RATES}, wrapping at the end. Returns the new rate. */
  cycleRate(): NarrationRate;
  getState(): NarrationState;
  /** True when the platform has no speech synthesis at all. */
  isSupported(): boolean;
}

/**
 * True when the current environment can speak. jsdom and older Safari both
 * report false, which lets callers degrade to a silent no-op.
 */
export function isSpeechSynthesisSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.speechSynthesis !== "undefined" &&
    window.speechSynthesis !== null &&
    typeof window.SpeechSynthesisUtterance === "function"
  );
}

/**
 * Turns raw amounts into speech-friendly text.
 *
 * A synthesiser reads "25,000" and "3.50%" inconsistently, and the
 * punctuation of a formatted number can cause it to drop trailing digits or
 * announce the separator as punctuation. Stripping separators and expanding
 * symbols keeps the spoken output unambiguous.
 */
export function toSpokenNumber(value: number): string {
  if (!Number.isFinite(value)) return "unknown";
  const rounded = Math.round(value * 100) / 100;
  return rounded.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/** "25000" / 25000 -> "25,000", safe for non-numeric input. */
export function toDisplayNumber(value: number | string): string {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toLocaleString("en-US");
}

/**
 * Renders a USDC amount as a spoken sentence, e.g.
 * `"25,000 USDC"` spoken as `"25,000 U S D C"`.
 */
export function speakAmount(amount: number, symbol = "USDC"): string {
  return `${toDisplayNumber(amount)} ${spellOutSymbol(symbol)}`;
}

/** Spells a ticker out so it is not read as a word or mispronounced. */
export function spellOutSymbol(symbol: string): string {
  return symbol
    .split("")
    .map((character) => (character === "." ? " point " : character))
    .join(" ");
}

/** Renders a basis-point rate as speech, e.g. 650 bps -> "6.5 percent". */
export function speakRateBps(bps: number): string {
  if (!Number.isFinite(bps)) return "unknown";
  const percent = bps / 100;
  const spoken = Number.isInteger(percent)
    ? percent.toString()
    : percent.toFixed(2).replace(/0+$/, "");
  return `${spoken} percent`;
}

/** Renders a term length in words, e.g. 24 -> "2 years, 0 months". */
export function speakTermMonths(months: number): string {
  if (!Number.isFinite(months) || months <= 0) return "unknown";
  const whole = Math.floor(months);
  const years = Math.floor(whole / 12);
  const remainder = whole % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} ${years === 1 ? "year" : "years"}`);
  if (remainder > 0 || years === 0)
    parts.push(`${remainder} ${remainder === 1 ? "month" : "months"}`);
  return parts.join(", ");
}

/**
 * Collects narratable segments from a subtree in reading order.
 *
 * The returned order is the order they will be spoken: ascending
 * `data-narration-order` when present, then DOM position.
 */
export function collectNarrationSegments(root: ParentNode): NarrationSegment[] {
  const elements = Array.from(root.querySelectorAll(`[${NARRATION_ATTRIBUTE}]`));

  const segments = elements.map((element, position) => {
    const authored = element.getAttribute(NARRATION_ATTRIBUTE) ?? "";
    const explicitOrder = Number(element.getAttribute(NARRATION_ORDER_ATTRIBUTE));

    return {
      text: authored.trim(),
      order: Number.isFinite(explicitOrder) ? explicitOrder : position,
      position,
    };
  });

  return segments
    .filter((segment) => segment.text.length > 0)
    .sort((left, right) => left.order - right.order || left.position - right.position);
}

/**
 * Builds a narration engine bound to a speech synthesis implementation.
 *
 * Playback walks the segment list one utterance at a time rather than handing
 * the whole queue to `speechSynthesis.speak()`. That is what makes replay of a
 * single term and mid-run speed changes possible: the engine always knows
 * which segment is live, so it can restart exactly that one.
 */
export function createNarrationEngine(options: NarrationEngineOptions = {}): NarrationEngine {
  const {
    synth: injectedSynth,
    createUtterance: injectedFactory,
    voice = null,
    rate: initialRate = DEFAULT_NARRATION_RATE,
    onStateChange,
  } = options;

  function resolveSynth(): SpeechSynthesisLike | null {
    if (injectedSynth !== undefined) return injectedSynth;
    if (typeof window === "undefined") return null;
    return (window.speechSynthesis as unknown as SpeechSynthesisLike) ?? null;
  }

  function resolveFactory(): UtteranceFactory | null {
    if (injectedFactory) return injectedFactory;
    if (typeof window === "undefined" || typeof window.SpeechSynthesisUtterance !== "function") {
      return null;
    }
    return (text: string) =>
      new window.SpeechSynthesisUtterance(text) as unknown as SpeechSynthesisUtteranceLike;
  }

  let segments: NarrationSegment[] = [];
  let index = 0;
  let rate: NarrationRate = initialRate;
  let status: NarrationStatus = "idle";
  /**
   * Identifies the current playback attempt. Bumped every time an in-flight
   * utterance is deliberately abandoned (cancel, replay, restart, stop), which
   * makes the handlers of that utterance stale.
   *
   * A single shared boolean cannot do this job: `replayCurrent` clears the
   * flag before the abandoned utterance's `onerror` arrives, so that error
   * would still be treated as the replayed segment finishing and would skip
   * the queue forward. Tagging each utterance with the attempt it belongs to
   * makes the staleness check per-utterance instead.
   */
  let generation = 0;

  function emit() {
    onStateChange?.({ status, index, total: segments.length, rate });
  }

  function setStatus(next: NarrationStatus) {
    status = next;
    emit();
  }

  function stop() {
    const synth = resolveSynth();
    // Retire the in-flight utterance before cancelling it, so the `onerror`
    // that `cancel()` triggers cannot advance the queue.
    generation += 1;
    synth?.cancel();
    setStatus("idle");
  }

  /** Speaks the segment at `index` and chains to the next via `onend`. */
  function speakCurrent() {
    const synth = resolveSynth();
    const factory = resolveFactory();
    const segment = segments[index];

    if (!synth || !factory || !segment) {
      setStatus(segments.length ? "done" : "idle");
      return;
    }

    const attempt = generation;
    const utterance = factory(segment.text);
    utterance.rate = rate;

    if (voice) {
      (utterance as unknown as { voice?: SpeechSynthesisVoice }).voice = voice;
    }

    /** False once this utterance has been superseded by a later attempt. */
    const isCurrent = () => attempt === generation;

    const advance = () => {
      // Final segment: the run is over.
      if (index + 1 >= segments.length) {
        setStatus("done");
        return;
      }
      index += 1;
      speakCurrent();
      emit();
    };

    utterance.onend = () => {
      if (!isCurrent()) return;
      advance();
    };

    utterance.onerror = () => {
      if (!isCurrent()) return;
      // A genuinely interrupted utterance (voice unavailable, hardware
      // error) should not wedge the queue, so move on to the next term.
      advance();
    };

    setStatus("speaking");
    synth.speak(utterance);
  }

  function play() {
    if (!segments.length) {
      setStatus("idle");
      return;
    }
    index = 0;
    // Retire any in-flight utterance before cancelling, so its error cannot
    // skip us past the segment we are about to speak.
    generation += 1;
    resolveSynth()?.cancel();
    speakCurrent();
  }

  function pause() {
    if (status !== "speaking") return;
    resolveSynth()?.pause();
    setStatus("paused");
  }

  function resume() {
    if (status !== "paused") return;
    // Chrome leaves `paused` stuck if resume is called without a fresh
    // speak() on a paused queue, so resume the underlying synth and reflect
    // the transition ourselves.
    resolveSynth()?.resume();
    setStatus("speaking");
  }

  function replayCurrent() {
    if (!segments.length) return;
    // Stay on the same index: this is the difference between "hear that
    // number again" and "start over". The previous utterance of this segment
    // is retired so its trailing error cannot advance the queue.
    generation += 1;
    resolveSynth()?.cancel();
    speakCurrent();
  }

  function restart() {
    play();
  }

  function setRate(next: NarrationRate) {
    rate = next;
    // The live utterance cannot be re-rated mid-flight, but every subsequent
    // segment picks the new rate up. Report it immediately so the UI control
    // stays in sync with what the user chose.
    emit();
  }

  function cycleRate() {
    const current = NARRATION_RATES.indexOf(rate);
    const next = NARRATION_RATES[(current + 1) % NARRATION_RATES.length];
    setRate(next);
    return next;
  }

  function load(next: NarrationSegment[]) {
    stop();
    segments = next;
    index = 0;
    setStatus("idle");
  }

  return {
    load,
    play,
    pause,
    resume,
    replayCurrent,
    restart,
    stop,
    setRate,
    cycleRate,
    getState: () => ({ status, index, total: segments.length, rate }),
    isSupported: () => Boolean(resolveSynth()) && Boolean(resolveFactory()),
  };
}
