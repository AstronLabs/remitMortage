// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Minimal immutable fluent builder shared by every test data factory.
 *
 * A builder holds a `make(seq)` function (the single place that knows the
 * entity's default shape) plus a list of queued overrides. Every fluent call
 * returns a *new* builder, so a named variant such as `loanFactory.overdue()`
 * can be safely reused and further customised:
 *
 *   loanFactory.overdue().with({ missedPayments: 3 }).build();
 */

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Date | string | number | boolean | null | undefined
    ? T[K]
    : T[K] extends Array<unknown>
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Deep-merge plain objects; arrays, Dates and primitives are replaced wholesale. */
export function mergeOverrides<T>(base: T, overrides: DeepPartial<T>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeOverrides(current, value) : value;
  }
  return out as T;
}

/** Per-factory monotonically increasing counter used for ids and addresses. */
export class Sequence {
  private n = 0;
  next(): number {
    this.n += 1;
    return this.n;
  }
  reset(): void {
    this.n = 0;
  }
}

const sequences = new Set<Sequence>();

/** Create a sequence that `resetFactorySequences()` will rewind. */
export function createSequence(): Sequence {
  const seq = new Sequence();
  sequences.add(seq);
  return seq;
}

/** Rewind every factory counter; call from `beforeEach` for deterministic ids. */
export function resetFactorySequences(): void {
  for (const seq of sequences) seq.reset();
}

export class Builder<T extends object> {
  protected constructor(
    protected readonly makeDefaults: (seq: number) => T,
    protected readonly sequence: Sequence,
    protected readonly queued: ReadonlyArray<DeepPartial<T>> = []
  ) {}

  /** Queue overrides; later calls win over earlier ones. Returns a new builder. */
  with(overrides: DeepPartial<T>): this {
    const next = Object.create(Object.getPrototypeOf(this)) as this;
    // safe-merge-ok: test-only builder copying its own fields onto a fresh object
    Object.assign(next, this, { queued: [...this.queued, overrides] });
    return next;
  }

  /** Build one entity. Optional `overrides` apply last. */
  build(overrides: DeepPartial<T> = {}): T {
    const base = this.makeDefaults(this.sequence.next());
    return [...this.queued, overrides].reduce<T>((acc, o) => mergeOverrides(acc, o), base);
  }

  /** Build `count` entities; `overrides` may vary per index. */
  buildMany(count: number, overrides: DeepPartial<T> | ((index: number) => DeepPartial<T>) = {}): T[] {
    return Array.from({ length: count }, (_, i) =>
      this.build(typeof overrides === "function" ? overrides(i) : overrides)
    );
  }
}
