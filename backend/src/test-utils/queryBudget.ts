// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export interface RecordedQuery {
  label: string;
  durationMs?: number;
}

export class QueryCounter {
  private readonly queries: RecordedQuery[] = [];

  record(label: string, durationMs?: number): void {
    this.queries.push({ label, durationMs });
  }

  count(): number {
    return this.queries.length;
  }

  getQueries(): readonly RecordedQuery[] {
    return [...this.queries];
  }

  reset(): void {
    this.queries.length = 0;
  }
}

export interface QueryBudgetResult<T> {
  result: T;
  queryCount: number;
  queries: readonly RecordedQuery[];
}

/**
 * Counts database queries executed during `fn` using a scoped QueryCounter.
 */
export async function countQueries<T>(
  fn: (counter: QueryCounter) => Promise<T> | T
): Promise<QueryBudgetResult<T>> {
  const counter = new QueryCounter();
  const result = await fn(counter);
  return {
    result,
    queryCount: counter.count(),
    queries: counter.getQueries(),
  };
}

/**
 * Asserts that `fn` executes at most `maxQueries` database queries.
 * Throws a detailed error listing the executed queries when the budget is exceeded
 * (catching N+1 query-per-row regressions in test runs).
 */
export async function assertQueryBudget<T>(
  endpointName: string,
  maxQueries: number,
  fn: (counter: QueryCounter) => Promise<T> | T
): Promise<QueryBudgetResult<T>> {
  const measured = await countQueries(fn);
  if (measured.queryCount > maxQueries) {
    const summary = measured.queries.map((q, i) => `  ${i + 1}. ${q.label}`).join("\n");
    throw new Error(
      `N+1 query budget exceeded for ${endpointName}: executed ${measured.queryCount} queries (budget: ${maxQueries}).\nQueries:\n${summary}`
    );
  }
  return measured;
}

/**
 * Query budgets for the five busiest list endpoints.
 * Keep these tight so adding a per-row query in a list handler immediately fails tests.
 */
export const LIST_ENDPOINT_QUERY_BUDGETS = Object.freeze({
  "GET /api/loan": 3,
  "GET /api/admin/audit": 3,
  "GET /api/notifications": 3,
  "GET /api/watchlist": 3,
  "GET /api/admin/dsar": 2,
});
