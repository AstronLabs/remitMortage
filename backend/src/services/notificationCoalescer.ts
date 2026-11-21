// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Coalesces rapid duplicate notifications into one.
 *
 * Repeated triggers of the same notification type to the same recipient in a
 * short window — several failed sign-in attempts in a row, say — can otherwise
 * queue one notification per trigger and flood the recipient. This module keeps
 * a window per `(type, recipient)` pair: the first trigger of a burst is
 * returned with `deliver: true` so the caller sends it immediately, further
 * triggers within the window are folded into the pending one, and when the
 * window closes a single `flush` callback reports the total count.
 *
 * The scheduling primitive is injectable so the window can be driven
 * deterministically in tests.
 */

/** Default length of a coalescing window: short enough to still feel live. */
export const DEFAULT_COALESCE_WINDOW_MS = 30_000;

const KEY_SEPARATOR = "\u0000";

/** Identifies a coalescing window: a logical notification type + recipient. */
export interface CoalesceKey {
  type: string;
  recipient: string;
}

export interface CoalesceDecision {
  /** True when this is the first trigger of a new window — deliver it now. */
  deliver: boolean;
  /** Number of triggers observed in the window so far, including this one. */
  count: number;
}

/** Called when a window closes having folded more than one trigger. */
export type CoalesceFlush<T> = (key: CoalesceKey, count: number, sample: T) => void;

export interface NotificationCoalescerOptions<T> {
  /** Length of the coalescing window in milliseconds. */
  windowMs: number;
  /** Invoked when a window closes with more than one trigger. */
  flush: CoalesceFlush<T>;
  /** Schedules the window close. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Cancels a scheduled window close. Defaults to `clearTimeout`. */
  cancel?: (handle: unknown) => void;
}

interface WindowState<T> {
  count: number;
  sample: T;
  handle: unknown;
}

function keyOf(key: CoalesceKey): string {
  return `${key.type}${KEY_SEPARATOR}${key.recipient}`;
}

export class NotificationCoalescer<T> {
  private readonly windows = new Map<string, WindowState<T>>();
  private readonly windowMs: number;
  private readonly flush: CoalesceFlush<T>;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  constructor(options: NotificationCoalescerOptions<T>) {
    this.windowMs = options.windowMs;
    this.flush = options.flush;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel =
      options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Records one trigger. Returns `deliver: true` (and the running count) for the
   * first trigger of a window; subsequent triggers return `deliver: false` and
   * are folded into the window's count.
   */
  record(key: CoalesceKey, sample: T): CoalesceDecision {
    const id = keyOf(key);
    const existing = this.windows.get(id);
    if (existing) {
      existing.count += 1;
      return { deliver: false, count: existing.count };
    }

    const handle = this.schedule(() => this.close(id), this.windowMs);
    this.windows.set(id, { count: 1, sample, handle });
    return { deliver: true, count: 1 };
  }

  /** Cancels every pending window without flushing. */
  clear(): void {
    for (const state of this.windows.values()) this.cancel(state.handle);
    this.windows.clear();
  }

  private close(id: string): void {
    const state = this.windows.get(id);
    if (!state) return;
    this.windows.delete(id);
    if (state.count <= 1) return;

    const separator = id.indexOf(KEY_SEPARATOR);
    this.flush(
      { type: id.slice(0, separator), recipient: id.slice(separator + 1) },
      state.count,
      state.sample
    );
  }
}
