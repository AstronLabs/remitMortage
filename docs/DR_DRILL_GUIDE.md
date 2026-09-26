# Disaster Recovery Drill Guide

## Overview

The `dr-drill.yml` GitHub Actions workflow runs a scheduled, automated, end-to-end disaster
recovery drill against the **staging** environment every first Tuesday of the month. It exercises
both the **application traffic layer** (Route 53 DNS failover) and the **database failover layer**
(pg_dump → restore → validation), measures wall-clock recovery times, and fails the run with an
alert email if either the RTO or RPO target is breached.

---

## Targets

These numbers are sourced from `devops/MULTI_REGION_FAILOVER_GUIDE.md` and enforced by the `rto-rpo-gate` job:

| Target | Value | Measurement |
|--------|-------|-------------|
| RTO (Recovery Time Objective) | ≤ 5 minutes (300 s) | Time from simulated outage start to secondary endpoint returning healthy |
| RPO (Recovery Point Objective) | ≤ 15 minutes | Time between last data-seed checkpoint and restored replica being validated |

Override defaults for a manual run:

```
workflow_dispatch → rto_target_seconds: 300
                  → rpo_target_minutes: 15
```

---

## Drill Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      DR Drill Workflow                         │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  preflight ──→ traffic-failover-drill ──┐                     │
│           \──→ database-failover-drill ──┤──→ rto-rpo-gate    │
│                                         │         │           │
│                                         └──→ archive-report   │
│                                                   │           │
│                                    alert-on-failure (failure) │
└────────────────────────────────────────────────────────────────┘
```

### Job: `preflight`
Verifies both the primary and secondary staging endpoints respond healthy at `/api/health` before
the drill starts. If either is already down, the drill is aborted — avoiding measuring a
pre-existing outage instead of the drill itself.

### Job: `traffic-failover-drill`
1. Reads the primary Route 53 health-check ID from SSM parameter
   `/remitmortgage/staging/primary-health-check-id`.
2. Disables the health check via `aws route53 update-health-check --disabled`, which triggers
   Route 53 to begin routing all DNS queries to the secondary region.
3. Polls the secondary endpoint every 5 seconds, recording wall-clock time from fault injection
   to first healthy response.
4. Re-enables the health check in an `always()` cleanup step, even on failure.

> **Safety guardrail:** If the SSM parameter is absent, the job emits a warning and sets
> `SKIP_TRAFFIC_DRILL=true`. The gate still passes for the traffic layer. This prevents an
> unintended production impact if the parameter hasn't been configured yet.

### Job: `database-failover-drill`
Runs `scripts/dr-drill.sh` (see below) with two disposable in-runner Postgres 16 databases
standing in for the production primary/replica pair. The script:

1. Applies the live Prisma schema to a `drtest_primary` database and seeds it.
2. Records a **RPO baseline timestamp** immediately after seeding.
3. `pg_dump`s the primary and `pg_restore`s to `drtest_replica`.
4. Validates all core tables exist and row counts match.
5. Computes RTO (total drill duration) and RPO (time since baseline).
6. Writes results to `GITHUB_OUTPUT` for the gate job.

### Job: `rto-rpo-gate`
Reads both jobs' outputs and compares measured values against `RTO_TARGET_SECONDS` and
`RPO_TARGET_MINUTES`. Fails with `exit 1` if any target is exceeded.

### Job: `archive-report`
Always runs (pass or fail). Consolidates all drill outputs into a single `dr-drill-report.txt`
artifact with 365-day retention. This artifact is the **audit record** that the drill ran this
month.

### Job: `alert-on-failure`
Sends an alert email to `ALERT_EMAIL_TO` via the configured SMTP secrets when any gate job
fails on a scheduled or manual run. PR runs surface on the PR itself and do not page.

---

## Required Secrets

| Secret | Purpose |
|--------|---------|
| `DR_DRILL_AWS_ACCESS_KEY_ID` | AWS access key with Route 53 + SSM read permissions |
| `DR_DRILL_AWS_SECRET_ACCESS_KEY` | Corresponding secret key |
| `DR_DRILL_PRIMARY_URL` | Fallback primary staging URL (used if SSM param absent) |
| `DR_DRILL_SECONDARY_URL` | Fallback secondary staging URL |
| `ALERT_SMTP_SERVER` | SMTP server for failure alert emails |
| `ALERT_SMTP_PORT` | SMTP port |
| `ALERT_SMTP_USERNAME` | SMTP username |
| `ALERT_SMTP_PASSWORD` | SMTP password |
| `ALERT_EMAIL_TO` | Alert recipient address |

## Required SSM Parameters (Staging)

| Parameter | Value |
|-----------|-------|
| `/remitmortgage/staging/primary-url` | Staging primary App Runner URL |
| `/remitmortgage/staging/secondary-url` | Staging secondary App Runner URL |
| `/remitmortgage/staging/primary-health-check-id` | Route 53 health check ID for the primary |

---

## Interpreting a Failed Run

### `preflight` failed
One or both staging endpoints were already down before the drill ran. This is a pre-existing
environment issue, not a DR capability gap. Fix the environment and re-run the drill manually.

### `traffic-failover-drill` failed / `traffic_rto_seconds` > target
- DNS TTL + health-check polling interval determines the minimum possible RTO.
  Check `devops/route53-geo.tf` and `devops/MULTI_REGION_FAILOVER_GUIDE.md` for current TTL/interval settings.
- The secondary App Runner service may be stopped or unhealthy. Verify it is in `RUNNING` state.
- A Route 53 health check may be misconfigured. Check the health check path and port.

### `database-failover-drill` failed / RPO exceeded
- The seeded data arrived at the replica too slowly. In production this corresponds to replication
  lag or redo log shipping delay. Review your RDS read-replica lag metrics.
- RTO exceeded means the dump-restore cycle took longer than the target. Consider pg_dump
  parallelism (`-j` flag) or pg_basebackup for larger datasets.

### Gate passed, but `traffic_recovery_verified` is `skipped`
The traffic layer drill was skipped because the SSM parameter
`/remitmortgage/staging/primary-health-check-id` is not set. Set it to get full end-to-end
coverage.

---

## How to Intentionally Adjust Targets

The RTO/RPO targets are passed as workflow inputs. To run a drill with relaxed targets
(e.g., during initial infrastructure bring-up):

1. Go to **Actions → Disaster Recovery Drill → Run workflow**.
2. Set `rto_target_seconds` and/or `rpo_target_minutes` to your desired values.

To permanently change the defaults, edit the `env` block at the top of
`.github/workflows/dr-drill.yml`.

---

## Running the Database Drill Locally

```bash
export PRIMARY_DB_URL="postgresql://user:pass@localhost:5432/primary_db"
export REPLICA_DB_URL="postgresql://user:pass@localhost:5432/replica_db"
export RPO_BASELINE_TS="$(date +%s)"
export RTO_TARGET_SECONDS="300"
export RPO_TARGET_MINUTES="15"
export REPORT_PATH="dr-drill-report.txt"

bash scripts/dr-drill.sh
cat dr-drill-report.txt
```
