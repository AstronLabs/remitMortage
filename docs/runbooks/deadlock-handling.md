# Runbook: Interpreting Deadlock Detection Alerts

## Context
The Automated Deadlock Detection job periodically scans for queries that are blocked by lock contention, which can occur during concurrent loan/escrow operations on the same rows (e.g. simultaneous repayment and status update). 

## How to Interpret the Alert
When a deadlock is detected, the alert payload includes:
- **blockedPid / blockingPid**: The process IDs of the Postgres connections involved.
- **blockedQuery**: The query that is waiting and blocked.
- **blockingQuery**: The current active query of the process that holds the lock.

By comparing the `blockedQuery` and `blockingQuery`, you can identify the exact transactions (and often the backend code paths) that are conflicting.

## Mitigation Steps
1. **Identify the Code Paths**: Look at the tables involved in the queries (e.g., `LoanApplication` vs `Escrow`).
2. **Review Application Logic**: Ensure that transactions access tables/rows in the same consistent order across all codebase locations.
3. **Shorten Transactions**: If the blocking query is performing external API calls or heavy processing while holding the lock, refactor to release the lock sooner or do external calls before/after the transaction.
4. **Kill the Blocking Query**: If an operation is completely hung, you can manually terminate the blocking query using:
   ```sql
   SELECT pg_terminate_backend(<blockingPid>);
   ```
