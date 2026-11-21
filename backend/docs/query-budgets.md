# N+1 Query Budgets for Backend Tests

To prevent N+1 query regressions from reaching production, list endpoints must
stay within a fixed database query budget regardless of row count.

## Budgets for the Five Busiest List Endpoints

| Endpoint | Max Queries | Rationale |
|---|---|---|
| `GET /api/loan` | `3` | Auth/tenant lookup + paginated loans with `include`/batch join + total count |
| `GET /api/admin/audit` | `3` | Admin verification + paginated audit rows + total count |
| `GET /api/notifications` | `3` | User lookup + paginated notifications + unread count |
| `GET /api/watchlist` | `3` | User lookup + watchlist entries with joined offering details + count |
| `GET /api/admin/dsar` | `2` | Admin verification + DSAR list query |

## Setting a Budget for a New Endpoint

1. Add the endpoint's target budget to `LIST_ENDPOINT_QUERY_BUDGETS` in
   `backend/src/test-utils/queryBudget.ts`.
2. In your endpoint test, seed at least 10 rows and wrap the request or service
   call in `assertQueryBudget("GET /api/<endpoint>", budget, async (counter) => { ... })`.
3. Verify the query count remains constant when doubling the seeded row count
   (O(1) queries, not O(N)).
