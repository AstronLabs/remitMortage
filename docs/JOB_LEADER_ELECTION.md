# Advisory-Lock Leader Election for Scheduled Jobs

With several application instances running, every instance's cron fires the
same job. `services/jobLeaderElection.ts` makes exactly one instance execute
each scheduled run, using PostgreSQL advisory locks, so jobs no longer have to
be individually idempotent to be safe under replication.

## How a tick is decided

```
cron tick on every instance
   │
   ├─ pg_try_advisory_xact_lock(hash(job name))  ── not acquired ─▶ skip (lock_held)
   │
   ├─ mark leftover "running" rows abandoned     (holder must be dead)
   ├─ last completed run < minIntervalMs ago?    ── yes ─▶ skip (recently_run)
   │
   ├─ insert ScheduledJobRun {jobName, instanceId, startedAt}
   ├─ run the job
   └─ record succeeded / failed + duration, release the lock
```

- **Lock.** A transaction-scoped try-lock (`pg_try_advisory_xact_lock`) held by
  an open interactive transaction for the duration of the job; the job itself
  uses its normal pooled connections. Committing releases it, and **if the
  holder crashes or its connection drops, PostgreSQL rolls the transaction back
  and releases the lock immediately** — there is no TTL to wait out. The lock
  transaction's timeout (`maxHoldMs`, default 30 min) bounds a hung job; it
  must exceed the job's longest runtime.
- **`recently_run`.** The lock alone only stops *concurrent* runs. A replica
  whose cron fires a few hundred ms after the leader finished would otherwise
  run the job again, so within the lock the run is skipped if a succeeded/failed
  run started less than `minIntervalMs` ago (default 30 s; set it to about half
  the job's cadence and above inter-instance clock skew). Failed runs count: a
  failing job is not retried by each replica in turn — the next scheduled tick
  retries it.
- **Crash takeover.** Because a lock holder that is alive always finishes its
  row, any `running` row seen by a new lock holder belongs to a dead one. It is
  marked `abandoned` and ignored for the `recently_run` check, so the next
  instance proceeds even within the interval.
- **Fails closed.** If leadership cannot be determined (database unreachable)
  the tick is not run, logged, and counted as `leadership_error`.

## Using it

```ts
import { scheduledJob } from "../services/jobLeaderElection.js";

cron.schedule("0 * * * *", scheduledJob("rate-limit-audit", runRateLimitAuditJob), { timezone: "UTC" });
cron.schedule("*/5 * * * *", scheduledJob("analytics-refresh", refresh, { minIntervalMs: 10_000 }));
```

`scheduledJob` never rejects (cron callbacks must not). All cluster-wide
scheduled jobs in `jobs/scheduler.ts`, `partitionManager`, `analyticsRefresh`,
`webhookAutoDisable`, `ipfsOrphanCleanup` and `backupScheduler` are wrapped.
Deliberately **not** wrapped: jobs that act on per-process state and must run
on every instance — `jwtKeyRotation` (in-memory key ring), `secretsRotation`,
`webhookKeyRotation` and `mtlsRotationVerifier`.

`INSTANCE_ID` (optional) names the instance in `ScheduledJobRun`; otherwise
`hostname:pid:random` is used. `SCHEDULED_JOB_MIN_INTERVAL_MS` changes the
default `minIntervalMs`.

## Observability

| Metric | Labels | Meaning |
| --- | --- | --- |
| `remitmortgage_scheduled_job_skipped_total` | `job`, `reason` (`lock_held`, `recently_run`) | Runs this instance skipped because another instance is the leader |
| `remitmortgage_scheduled_job_runs_total` | `job`, `outcome` (`executed`, `failed`, `skipped_lock_held`, `skipped_recently_run`, `leadership_error`) | Ticks handled by this instance |

Summed across instances, `executed + failed` per job should match the number of
scheduled ticks, and `skipped` should be roughly `(replicas − 1) × ticks`.

Which instance ran what:

```sql
SELECT "jobName", "instanceId", "status", "startedAt", "durationMs"
FROM "ScheduledJobRun" WHERE "jobName" = 'kyc-expiry' ORDER BY "startedAt" DESC LIMIT 20;
```

`abandoned` rows mark runs whose instance died mid-job. Old rows are small and
can be pruned with a periodic `DELETE … WHERE "startedAt" < now() - interval '90 days'`.

## Connection pooling caveat

Because the lock is bound to a transaction, it is safe behind Prisma's pool and
behind PgBouncer in **transaction** pooling mode (the transaction pins one
server connection). Session-level `pg_advisory_lock` would not be, which is why
it is not used. Each running job holds one extra pooled connection for its
duration; size `connection_limit` accordingly
(see `docs/DB_CONNECTION_POOL_TUNING.md`). Avoid a very low
`idle_in_transaction_session_timeout` on the application role.

## Tests

`src/__tests__/jobLeaderElection.test.ts` races up to 12 simulated instances
(an in-memory model of PostgreSQL's advisory-lock semantics in
`test-utils/inMemoryAdvisoryLocks.ts`) for the same job and asserts a single
execution, the recorded instance, the straggler and next-tick cases, crash
takeover (lock released when a holder dies, run proceeds, dead row abandoned),
failure handling, metrics, and the SQL/transaction behaviour of the PostgreSQL
backend.
