# Query Plan Regression Baselines

`backend/scripts/query-plan-regression.ts` runs the tracked critical query with `EXPLAIN (FORMAT JSON)` and compares node types and index names with `backend/query-plan-baselines.json`. A sequential scan or a missing expected index fails CI even when execution time remains below the timing threshold.

After an intentional, reviewed schema or query change:

1. Run the performance workflow against the migration.
2. Inspect the reported JSON plan and confirm the new scan and index choices are intentional.
3. Update `backend/query-plan-baselines.json` in the same change.
4. Keep the query catalog and baseline update together so reviewers can see why the plan changed.

The baseline is a contract for plan shape, not a claim that every PostgreSQL version produces byte-identical JSON.
