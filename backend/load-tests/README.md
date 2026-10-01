# Load Testing — RemitMortgage Backend

Stress-tests for the PostgreSQL persistence layer under concurrent traffic.

## Tool

[autocannon](https://github.com/mcollina/autocannon) — a Node.js HTTP benchmarking
tool included as a dev dependency. No extra binary installation required.

## Scripts

| Script | Purpose |
|--------|---------|
| `run-all.ts` | Orchestrates the full suite in sequence |
| `scenarios/health-read.ts` | Baseline — GET /api/health (DB ping) |
| `scenarios/audit-log-read.ts` | Heavy paginated read — GET /api/audit-logs |
| `scenarios/analytics-read.ts` | Cached aggregate read — GET /api/analytics/overview |
| `scenarios/loan-status-read.ts` | Indexed read — GET /api/loan/pending |
| `scenarios/verification-write.ts` | Write-heavy — POST /api/verification/check |
| `scenarios/mixed-workload.ts` | 70 % reads / 30 % writes concurrent mix |
| `scenarios/webhook-burst.ts` | Burst webhook delivery — latency, queue depth, retries/DLQ at increasing throughput (scheduled only, needs Redis) |

## Quick Start

```bash
# Make sure the backend is running first:
npm run dev        # in a separate terminal

# Run the full suite (all scenarios sequentially):
npx tsx load-tests/run-all.ts

# Run a single scenario:
npx tsx load-tests/scenarios/audit-log-read.ts

# Override defaults via env vars:
BASE_URL=http://localhost:4000 \
ADMIN_API_KEY=your_key \
LOAD_CONNECTIONS=50 \
LOAD_DURATION=30 \
LOAD_PIPELINING=1 \
  npx tsx load-tests/run-all.ts
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:4000` | API base URL |
| `ADMIN_API_KEY` | `default_admin_api_key` | Bearer token for admin routes |
| `LOAD_CONNECTIONS` | `10` | Concurrent virtual users |
| `LOAD_DURATION` | `20` | Test duration in seconds |
| `LOAD_PIPELINING` | `1` | HTTP pipelining factor |

## Reading Results

Each scenario prints:
- **Latency** p50 / p95 / p99 / max (ms)
- **Throughput** requests/sec and bytes/sec
- **Error rate** non-2xx responses and timeouts

A summary table is printed at the end of `run-all.ts`.

## Webhook Burst Test (scheduled, not per-PR)

`scenarios/webhook-burst.ts` (issue #761) simulates a burst of
webhook-triggering events and sweeps throughput levels (`50,200,500`
deliveries by default), reporting per-level delivery latency, max queue
depth, retries, DLQ arrivals, and sustained throughput — stopping at the
first level that breaches the p95 SLA. The tested safe ceiling and the
backpressure rules that follow from it live in
`docs/WEBHOOK_THROUGHPUT_CEILING.md`.

```bash
# Needs Redis:
REDIS_URL=redis://localhost:6379 \
WEBHOOK_BURST_LEVELS="50,200,500" WEBHOOK_BURST_CONCURRENCY=20 \
npm run load-test:webhook-burst
```

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://localhost:6379` | Redis for the isolated burst queue |
| `WEBHOOK_BURST_LEVELS` | `50,200,500` | Burst sizes swept (stops at first breach) |
| `WEBHOOK_BURST_CONCURRENCY` | `20` | Worker concurrency (mirrors production) |
| `SINK_LATENCY_MS` | `25` | Simulated subscriber response latency |
| `SINK_FAIL_RATE` | `0` | Simulated subscriber 500 rate (exercises retries/DLQ) |
| `WEBHOOK_BURST_P95_SLA_MS` | `2000` | p95 breach threshold |
| `ENFORCE_SLA` | `0` | Set `1` in the scheduled run so a moved ceiling fails loudly |

## Acceptance Thresholds (CI)

The runner exits with code 1 if any scenario breaches:
- p99 latency > 500 ms
- Error rate > 1 %
