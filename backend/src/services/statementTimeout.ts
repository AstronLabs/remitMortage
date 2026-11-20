// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Per-request PostgreSQL statement timeouts (issue #1034).
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * A runaway or badly-planned query (missing index, accidental cross join, an
 * app bug) can hold a pooled connection indefinitely. Every second it runs is a
 * connection the rest of the service cannot use, so a single such query can
 * starve the pool and turn a healthy service into a timing-out one.
 *
 * ── Approach ────────────────────────────────────────────────────────────────
 *
 * PostgreSQL ships a per-session `statement_timeout` GUC that cancels any
 * statement still running after the configured number of milliseconds, raising
 * SQLSTATE `57014` (`query_canceled`). We install a conservative default for
 * every pooled connection through the libpq `options` startup parameter (see
 * {@link buildStatementTimeoutOption}, applied in `dbPoolConfig.ts`), so the
 * database — not the application — is what cuts a statement off.
 *
 * Some jobs are legitimately long (large exports, report materialisation) and
 * must not be subject to the interactive default. Those run inside
 * {@link runWithStatementTimeout}, which raises the limit for exactly one
 * transaction via `SET LOCAL statement_timeout = ...`; `SET LOCAL` is scoped to
 * the transaction and reverts to the connection default when it commits, so a
 * long job never leaks its longer budget to ordinary requests.
 *
 * Finally, a timeout is a transient condition, not a server fault. When one
 * surfaces, {@link toStatementTimeoutError} turns it into a clear, retryable
 * error that the central `errorHandler` renders as HTTP 503 + `Retry-After`.
 */

/** SQLSTATE raised by PostgreSQL when `statement_timeout` cancels a statement. */
export const STATEMENT_TIMEOUT_SQLSTATE = "57014";

/** Default statement timeout for ordinary requests, in milliseconds. */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Default statement timeout for explicitly-overridden long-running jobs, in
 * milliseconds. Chosen to stay under the runaway-query killer's five-minute
 * threshold (`queryKiller.ts`) so the two safety nets don't fight.
 */
export const DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Parse a positive integer from an env var, falling back when the value is
 * missing, non-numeric, or not positive — a timeout of 0 or less is always a
 * configuration mistake and must not silently disable the guard.
 */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve the default statement timeout (ms) for ordinary requests. */
export function getStatementTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env.DB_STATEMENT_TIMEOUT_MS, DEFAULT_STATEMENT_TIMEOUT_MS);
}

/** Resolve the statement timeout (ms) used by explicitly long-running jobs. */
export function getLongRunningStatementTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  return positiveInt(
    env.DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS,
    DEFAULT_LONG_RUNNING_STATEMENT_TIMEOUT_MS
  );
}

/**
 * Build the libpq `options` startup value that installs `statement_timeout` on
 * every session a pool opens, percent-encoded for use as a connection-URL query
 * parameter. The `-c` flag is attached (`-cstatement_timeout=...`) so the value
 * contains no space to encode, leaving only the `=` to escape.
 */
export function buildStatementTimeoutOption(ms: number): string {
  return `-cstatement_timeout%3D${Math.floor(ms)}`;
}

/**
 * True when `err` is a PostgreSQL statement-timeout cancellation. Prisma
 * surfaces driver errors in several shapes depending on the adapter and whether
 * the failing operation was a model call or a raw query, so we inspect the code
 * on the error and its `cause` chain and fall back to the canonical message.
 */
export function isStatementTimeoutError(err: unknown): boolean {
  let current: any = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if (current instanceof StatementTimeoutError) return true;

    const code = current.code ?? current.meta?.code ?? current.originalCode;
    if (code === STATEMENT_TIMEOUT_SQLSTATE) return true;

    const message = typeof current.message === "string" ? current.message : "";
    if (/statement timeout|canceling statement due to statement timeout/i.test(message)) {
      return true;
    }

    current = current.cause;
  }
  return false;
}

/**
 * Clear, retryable error surfaced to callers when a statement is cut off by the
 * database statement timeout. Carries the HTTP mapping (`503`, `retryable`) so
 * the error handler and route-level catches agree on the response shape.
 */
export class StatementTimeoutError extends Error {
  readonly statusCode = 503;
  readonly retryable = true;
  readonly code = "statement_timeout";
  readonly timeoutMs?: number;

  constructor(timeoutMs?: number) {
    super(
      "The request took too long and was cancelled by the database statement " +
        "timeout. It is safe to retry."
    );
    this.name = "StatementTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Map a statement-timeout failure to {@link StatementTimeoutError}, leaving any
 * other error (and an already-mapped one) untouched so callers can wrap a
 * generic failure path without rewriting unrelated errors.
 */
export function toStatementTimeoutError(err: unknown, timeoutMs?: number): unknown {
  if (err instanceof StatementTimeoutError) return err;
  return isStatementTimeoutError(err) ? new StatementTimeoutError(timeoutMs) : err;
}

/** Minimal Prisma-like surface needed to run with an explicit statement timeout. */
export interface StatementTimeoutClient {
  $transaction?: (
    fn: (tx: any) => Promise<any>,
    options?: { maxWait?: number; timeout?: number }
  ) => Promise<any>;
  [key: string]: any;
}

/**
 * Head-room added to Prisma's interactive-transaction timeout so the database's
 * `statement_timeout` is always what cancels a runaway statement. Prisma's
 * interactive-transaction `timeout` defaults to 5 s; a long-running job would
 * otherwise be aborted by Prisma first, losing the clean 57014 signal.
 */
const TRANSACTION_TIMEOUT_BUFFER_MS = 10_000;

/**
 * Run `fn` with an explicit statement timeout that overrides the connection
 * default for the duration of a single transaction.
 *
 * The callback receives a transaction client and must issue its statements
 * through it. The override applies via `SET LOCAL`, which PostgreSQL reverts
 * when the transaction ends, so the longer budget never leaks to other work
 * sharing the connection. A `57014` raised inside is converted into a
 * {@link StatementTimeoutError}.
 *
 * When the client exposes no interactive `$transaction` (e.g. a lightweight
 * test double), the callback runs directly so behaviour degrades gracefully
 * instead of throwing.
 */
export async function runWithStatementTimeout<T>(
  client: StatementTimeoutClient,
  timeoutMs: number,
  fn: (tx: any) => Promise<T>
): Promise<T> {
  const run = async (tx: any): Promise<T> => {
    if (typeof tx.$executeRawUnsafe === "function") {
      // `timeoutMs` is a resolved positive integer, never caller-controlled SQL.
      await tx.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`
      );
    }
    try {
      return await fn(tx);
    } catch (err) {
      throw toStatementTimeoutError(err, timeoutMs);
    }
  };

  if (typeof client.$transaction === "function") {
    try {
      // Raise Prisma's transaction budget above the statement timeout so the
      // database is the component that cuts the statement off.
      const transactionBudgetMs = timeoutMs + TRANSACTION_TIMEOUT_BUFFER_MS;
      return await client.$transaction(run, {
        maxWait: transactionBudgetMs,
        timeout: transactionBudgetMs,
      });
    } catch (err) {
      throw toStatementTimeoutError(err, timeoutMs);
    }
  }

  return run(client);
}
