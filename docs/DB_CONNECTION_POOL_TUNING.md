# Database Connection Pool: Monitoring, Alerting and Tuning

Pool exhaustion is one of the few failure modes that turns a healthy service
into a timing-out one with no code change and no deploy — it just needs enough
concurrent traffic. This document covers what the backend exposes, what alerts
on it, and how to size the pool.

## What is exposed

The backend publishes these on `/metrics` (see `backend/src/services/dbPoolMetrics.ts`):

| Metric | Type | Meaning |
| --- | --- | --- |
| `remitmortgage_db_pool_max_connections` | gauge | Configured `connection_limit` for this process |
| `remitmortgage_db_pool_in_flight_queries` | gauge | Operations issued and not yet resolved |
| `remitmortgage_db_pool_utilization_ratio` | gauge | `min(in_flight, max) / max`, clamped to 1 |
| `remitmortgage_db_pool_queued_queries` | gauge | `max(0, in_flight - max)` — operations waiting for a connection |
| `remitmortgage_db_pool_peak_in_flight_queries` | gauge | High-water mark since process start |
| `remitmortgage_db_query_duration_seconds` | histogram | Operation latency, labelled by model and operation |
| `remitmortgage_db_pool_timeouts_total` | counter | Failed acquisitions (Prisma `P2024`) |
| `remitmortgage_db_query_errors_total` | counter | All failures, by Prisma error code |

### How utilization is derived, and its one limitation

Prisma used to expose engine-internal pool gauges via `prisma.$metrics`
(`prisma_pool_connections_open`, `_busy`, `_idle`). **That API does not exist in
Prisma 7**, which this project uses — the query-compiler runtime dropped it. The
pool's own counters are therefore not readable from the client.

What is observable is demand. Every in-flight Prisma operation needs a pool
connection to make progress, so the count of issued-but-unresolved operations is
the load the pool is being asked to carry. Utilization is that count over the
configured `connection_limit`.

The limitation this carries: it **cannot distinguish an open-but-idle connection
from a closed one**. If you want to know how many TCP connections are actually
established, query the server instead:

```sql
SELECT count(*), state FROM pg_stat_activity
WHERE datname = current_database() GROUP BY state;
```

For saturation alerting the distinction does not matter — what matters is
whether demand is approaching the ceiling, which is exactly what the ratio
measures.

Two consequences worth knowing:

- The gauges are **per process**. With N replicas the database sees up to
  `N × connection_limit` connections. Alert per instance; size against the sum.
- A utilization of 1.0 means *demand met the ceiling*, not that the pool has
  failed. Pair it with `db_pool_queued_queries` and `db_pool_timeouts_total` to
  tell "busy" from "broken".

## Alerting

`devops/prometheus/db-pool-alerts.yml` defines five rules:

| Alert | Condition | Severity |
| --- | --- | --- |
| `DbPoolUtilizationHigh` | 15m average above 80% | warning |
| `DbPoolUtilizationCritical` | 5m average above 95% | critical |
| `DbPoolQueueBuilding` | queued > 0 for a continuous 5m | warning |
| `DbPoolConnectionTimeouts` | any P2024 in 5m | critical |
| `DbPoolMetricsNotReporting` | `max_connections == 0` for 10m | warning |

Load it into Prometheus:

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/db-pool-alerts.yml
```

Under the Prometheus Operator, wrap the `groups` block in a `PrometheusRule`
custom resource.

The two thresholds worth tuning are the `0.8` and `0.95` literals in the first
two rules. Everything else derives from them.

`DbPoolUtilizationHigh` is the rule that satisfies the "warn before exhaustion"
requirement: it fires on sustained pressure while connections remain, whereas
`DbPoolConnectionTimeouts` only fires once requests are already failing. If the
warning consistently fires without the critical following, the pool is correctly
sized for peak but has no headroom for growth.

### Why the windows are what they are

- **15m for the warning.** Long enough that a deploy, a cron burst or a single
  slow query cannot trip it; short enough to act before organic growth becomes
  an outage.
- **5m for critical and for queueing.** At 95% the pool has minutes of headroom,
  not hours.
- **`min_over_time` for the queue rule**, not `avg`. A queue that empties even
  briefly is a burst absorbed correctly. `min_over_time > 0` requires the queue
  to have been non-empty for the *entire* window, which is the condition that
  actually delays users.
- **0m for timeouts.** P2024 is already a user-facing failure; there is nothing
  to wait for.

## Tuning

### Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `DB_CONNECTION_LIMIT` | `20` | Max connections per process |
| `DB_POOL_TIMEOUT` | `15` | Seconds to wait for a connection before P2024 |
| `DB_CONNECT_TIMEOUT` | `30` | Seconds for the initial TCP handshake |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | Per-statement timeout for ordinary requests |
| `DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS` | `300000` | Per-statement timeout for explicitly long-running jobs |

Resolved in `backend/src/services/dbPoolConfig.ts` and appended to
`DATABASE_URL` as query parameters. A value that is missing, non-numeric or
non-positive falls back to the default rather than being honoured.

### Statement timeouts

A runaway or badly-planned query can hold a pooled connection indefinitely, so
the pool drains one request at a time until every caller times out. To stop that
at the source, the pool installs a PostgreSQL `statement_timeout` on every
connection via the libpq `options` startup parameter, and the database cancels
any statement that outruns it — releasing the connection instead of holding it.

- `DB_STATEMENT_TIMEOUT_MS` is the limit for ordinary requests. It is a safety
  net, not a latency budget: it should sit comfortably above normal request
  latency and below the runaway-query killer's threshold (`queryKiller.ts`).
- `DB_LONG_RUNNING_STATEMENT_TIMEOUT_MS` is the limit for explicitly
  long-running jobs (for example the transaction export in
  `backend/src/routes/exports.ts`). Such a job runs inside
  `runWithStatementTimeout`, which raises the limit for a single transaction via
  `SET LOCAL statement_timeout`, so the longer budget reverts when the
  transaction ends and never leaks to ordinary requests sharing the connection.

When a statement is cancelled, the request fails cleanly with HTTP `503` and a
`Retry-After` header — the response body is `{ error: "statement_timeout",
retryable: true }`. Causing this on a healthy service means either a query
regressed or the limit is set too tight; investigate the former before raising
the latter.

### Sizing

Start from what the database can accept, not from what the app wants:

```
connection_limit  ≤  (postgres max_connections - superuser_reserved - other_clients)
                     ────────────────────────────────────────────────────────────
                                        number of app replicas
```

PostgreSQL defaults to `max_connections = 100` with 3 reserved. With 4 replicas
and a migration job needing headroom, roughly 20 per process is the ceiling —
which is where the default comes from.

Then check the workload against Little's Law:

```
connections_needed  ≈  peak_queries_per_second × average_query_seconds
```

At 200 q/s and a 40 ms mean, that is ~8 concurrent connections; 20 leaves
comfortable headroom. If the arithmetic says you need materially more than the
database budget allows, the answer is a connection pooler (PgBouncer in
transaction mode), not a larger per-process limit.

### Reading the metrics

Useful queries:

```promql
# Utilization across replicas
max by (instance) (remitmortgage_db_pool_utilization_ratio)

# Are we queueing?
sum(remitmortgage_db_pool_queued_queries)

# p99 operation latency — rises under contention
histogram_quantile(0.99,
  sum by (le) (rate(remitmortgage_db_query_duration_seconds_bucket[5m])))

# Which models hold connections longest
topk(5, sum by (model) (
  rate(remitmortgage_db_query_duration_seconds_sum[5m])
  / rate(remitmortgage_db_query_duration_seconds_count[5m])))
```

### Diagnosing before raising the limit

A rising pool utilization is a symptom. Raising `DB_CONNECTION_LIMIT` is only
the right fix when the load is genuine. Check first:

1. **Did latency rise before utilization did?** If p99 climbed first, a query
   regressed and is holding connections. Use the `topk` query above to find it.
   Fix the query; the pool recovers on its own.
2. **Is one model dominating?** A missing index shows up as a single model with
   a long mean duration.
3. **Is traffic actually up?** Correlate with
   `remitmortgage_http_requests_total`. Flat traffic with rising pool usage is a
   regression, not growth.
4. **Are connections leaking?** `peak_in_flight` far above steady-state
   `in_flight`, without matching traffic spikes, suggests operations that never
   settle.

Only once those are ruled out is the pool genuinely too small. Raise
`DB_CONNECTION_LIMIT`, confirm the database budget still balances, and redeploy.

### Raising the limit safely

1. Confirm `total replicas × new limit` still fits the database budget.
2. Raise it in increments, not multiples — doubling can move the bottleneck onto
   the database's own CPU or memory.
3. Watch `DbPoolConnectionTimeouts` and PostgreSQL's own connection count after
   the change.
4. If the required limit exceeds the database budget, deploy PgBouncer instead
   and point `DATABASE_URL` at it.
