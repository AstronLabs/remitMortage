# Webhook Delivery Throughput Ceiling

> Issue #761. Measured with `backend/load-tests/scenarios/webhook-burst.ts`
> (weekly schedule: `.github/workflows/webhook-burst-load.yml`). Update this
> file whenever a scheduled run moves the ceiling.

## Tested safe throughput ceiling

| Condition | Safe ceiling | Evidence |
|---|---|---|
| Healthy subscriber (~25 ms response, 0 % errors), worker concurrency 20 | **≈ 200 deliveries/burst at ~150–300/s sustained, p95 < 2000 ms** | Burst sweep `50,200,500`: 50- and 200-bursts drain within SLA; the 500-burst is where queue depth and p95 start climbing — the first breach point. |
| Degraded subscriber (> 1 s response or ≥ 5 % 5xx) | **Ceiling drops roughly proportionally to subscriber latency** — retries multiply queue pressure | Retry sweep (`SINK_FAIL_RATE`): exponential backoff (1 s base, 5 attempts, mirroring `services/queueService.ts`) absorbs transient failures; persistent failures land in `WebhookDLQ` as designed. |

These are order-of-magnitude guardrails from the harness, not per-subscriber
SLAs: the per-endpoint truth stays in `GET /api/admin/webhooks/latency`
(p50/p95/p99 dispatch-to-delivery + retry/DLQ counts, `slaBreached` flag).

## What the burst test measures at each level

- **Delivery latency** — enqueue→completed p50 / p95 / max / mean per burst.
- **Queue depth** — max sampled `waiting + active + delayed` while draining.
- **Retry behavior** — non-terminal failure events (retries) vs. terminal
  arrivals (DLQ). On a healthy subscriber the DLQ must stay at zero; any DLQ
  arrival there is a breach.
- **Throughput** — enqueue rate and sustained delivery rate per second.

The sweep stops at the first breaching level (larger bursts would only repeat
the failure); the JSON report lands in `backend/load-tests/results/`.

## Backpressure & rate-limiting to apply below the ceiling

1. **Cap burst intake.** Batch replays / bulk admin actions should fan out in
   chunks of ≤ 200 deliveries, awaiting drain (queue depth back under ~50)
   between chunks. Never enqueue an unbounded replay in one shot.
2. **Keep worker concurrency at 20** (`workers/webhookWorker.ts`) unless a
   scheduled run justifies a change — raising it without re-running the burst
   test just moves the failure to downstream subscribers' rate limits.
3. **Per-subscriber circuit breaking.** Endpoints flagged `slaBreached` by the
   latency report should be paused (`PATCH
   /api/webhooks/subscriptions/:id/status`) before a bulk replay, then
   resumed — a slow subscriber under burst load converts queue depth into
   retry storms.
4. **Alert on DLQ growth during bursts.** DLQ arrivals on a healthy subscriber
   mean the intake rate exceeded the ceiling: stop the replay, drain, and
   continue in smaller chunks.
5. **Do not gate deploys on this test.** Runtime cost (minutes + Redis) is why
   it runs weekly, not per-PR. `ENFORCE_SLA=1` fails the scheduled run on a
   breach so the ceiling gets re-examined; per-PR CI stays green regardless.

## Reproducing locally

```bash
# Redis first (docker compose up redis), then:
REDIS_URL=redis://localhost:6379 \
WEBHOOK_BURST_LEVELS="50,200,500" WEBHOOK_BURST_CONCURRENCY=20 \
npm run load-test:webhook-burst
```
