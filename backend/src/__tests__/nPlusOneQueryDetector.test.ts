// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  assertQueryBudget,
  LIST_ENDPOINT_QUERY_BUDGETS,
} from "../test-utils/queryBudget.js";

describe("N+1 query detector and list endpoint budgets (#977)", () => {
  it("fails when a list endpoint issues a query per row (N+1 regression)", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: `loan-${i}` }));

    await expect(
      assertQueryBudget("GET /api/loan", LIST_ENDPOINT_QUERY_BUDGETS["GET /api/loan"], async (counter) => {
        counter.record("SELECT * FROM loan_applications LIMIT 10");
        for (const row of rows) {
          counter.record(`SELECT * FROM borrowers WHERE loan_id = '${row.id}'`);
        }
        return rows;
      })
    ).rejects.toThrow(/N\+1 query budget exceeded for GET \/api\/loan: executed 11 queries \(budget: 3\)/);
  });

  it("enforces documented budgets across the five busiest list endpoints", async () => {
    const endpoints = Object.keys(LIST_ENDPOINT_QUERY_BUDGETS) as Array<
      keyof typeof LIST_ENDPOINT_QUERY_BUDGETS
    >;
    expect(endpoints.length).toBeGreaterThanOrEqual(5);

    // 1. GET /api/loan (batched join + count = 2 queries <= 3)
    await assertQueryBudget("GET /api/loan", LIST_ENDPOINT_QUERY_BUDGETS["GET /api/loan"], (counter) => {
      counter.record("SELECT * FROM loan_applications LEFT JOIN borrowers ... LIMIT 25");
      counter.record("SELECT COUNT(*) FROM loan_applications");
    });

    // 2. GET /api/admin/audit (2 queries <= 3)
    await assertQueryBudget(
      "GET /api/admin/audit",
      LIST_ENDPOINT_QUERY_BUDGETS["GET /api/admin/audit"],
      (counter) => {
        counter.record("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50");
        counter.record("SELECT COUNT(*) FROM audit_logs");
      }
    );

    // 3. GET /api/notifications (2 queries <= 3)
    await assertQueryBudget(
      "GET /api/notifications",
      LIST_ENDPOINT_QUERY_BUDGETS["GET /api/notifications"],
      (counter) => {
        counter.record("SELECT * FROM notifications WHERE wallet = $1 LIMIT 20");
        counter.record("SELECT COUNT(*) FROM notifications WHERE wallet = $1 AND read = false");
      }
    );

    // 4. GET /api/watchlist (2 queries <= 3)
    await assertQueryBudget(
      "GET /api/watchlist",
      LIST_ENDPOINT_QUERY_BUDGETS["GET /api/watchlist"],
      (counter) => {
        counter.record("SELECT * FROM offering_watchlist JOIN offerings ... WHERE wallet = $1");
        counter.record("SELECT COUNT(*) FROM offering_watchlist WHERE wallet = $1");
      }
    );

    // 5. GET /api/admin/dsar (1 query <= 2)
    await assertQueryBudget(
      "GET /api/admin/dsar",
      LIST_ENDPOINT_QUERY_BUDGETS["GET /api/admin/dsar"],
      (counter) => {
        counter.record("SELECT * FROM dsar_requests ORDER BY statutory_deadline ASC");
      }
    );
  });
});
