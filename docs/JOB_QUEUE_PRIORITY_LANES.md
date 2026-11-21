# Background Job Priority Lanes

The BullMQ queues use three priority lanes (issue #985). Lower BullMQ priority
numbers run first, so the lanes map to priorities `1`, `2` and `3`.

| Lane | BullMQ priority | Purpose |
|------|-----------------|---------|
| `high` | `1` | User-facing payment, security and loan notifications |
| `normal` | `2` | Partner webhooks, transactional email and push notifications |
| `low` | `3` | Bulk analytics persistence and report generation |

## Job assignments

The canonical catalog lives in `backend/src/services/queueFairness.ts`
(`JOB_LANE_CATALOG`).

| Job type | Lane | Why |
|----------|------|-----|
| `notification.EMAIL` | `high` | Payment received / loan status emails are time-sensitive to the borrower. |
| `notification.WEBHOOK` | `high` | Partner notifications about money movement should not wait behind bulk work. |
| `notification.SMS` | `high` | Same user-facing urgency as email. |
| `notification.PUSH` | `normal` | Informational and safe to batch briefly. |
| `webhook.delivery` | `normal` | Timely, but BullMQ retries absorb short delays. |
| `email.send` | `normal` | Transactional mail with retry support. |
| `analytics.persist` | `low` | Bulk write; must never delay notifications. |
| `report.generate` | `low` | The motivating example: long bulk reports. |

## Fair-share guarantee

A high-priority job enqueued behind a large low-priority backlog still runs
first while the low work is fresh. Once a waiting job exceeds
`QUEUE_STARVATION_THRESHOLD_MS` (default 30 s), it bypasses priority so the low
lane always makes progress and is never starved indefinitely.

## Metrics

`GET /metrics` exposes:

- `remitmortgage_queue_lane_depth{lane=...}` — waiting jobs per lane.
- `remitmortgage_queue_lane_oldest_wait_seconds{lane=...}` — age of the oldest waiting job.
- `remitmortgage_queue_lane_avg_wait_seconds{lane=...}` — mean wait time of sampled waiting jobs.

The admin fairness snapshot (`queueService.getFairnessMetrics()`) includes the
same per-lane depth and wait figures.
