# Automatic Rollback on Post-Deploy Health Failure

> A blue-green deploy is not "done" when traffic switches — it is done when
> the new slot has survived a health window. If it doesn't, the pipeline rolls
> back to the previous known-good slot without waiting for a human to notice.

Implemented in `.github/workflows/blue-green-deploy.yml`; the pass/fail logic
lives in `scripts/post-deploy-health-gate.mjs` (unit-tested by
`scripts/post-deploy-health-gate.test.mjs`).

## How a deploy is judged

1. The image is deployed to the **idle** slot, health-checked, and traffic is
   switched to it (unchanged). The previous slot keeps running the previous
   known-good image — the deploy never touches it.
2. **Post-Deploy Health Gate** then watches the newly active slot for
   `HEALTH_GATE_WINDOW_SECONDS` (default 300s), polling every
   `HEALTH_GATE_INTERVAL_SECONDS` (default 10s). It fails the deploy on
   either signal:

   | Signal | Fails when | Defaults |
   |---|---|---|
   | `health_check_failed` | `/api/health` is non-2xx, unreachable, or times out for N **consecutive** polls. One blip never fails the gate. | `HEALTH_GATE_MAX_CONSECUTIVE_FAILURES=3` |
   | `error_rate_exceeded` | The 5xx share of `remitmortgage_http_requests_total`, accumulated from counter deltas since the switch, exceeds the threshold — and only once enough requests were seen for the ratio to mean something. | `HEALTH_GATE_MAX_ERROR_RATE=0.05`, `HEALTH_GATE_MIN_REQUESTS=20` |

   The gate returns as soon as a signal fails, so a bad deploy is rolled back
   in tens of seconds, not after the whole window.
3. On failure the **Automatic Rollback** job restores the SSM
   `/remitmortgage/<env>/active-slot` pointer to the previous slot, verifies
   that slot answers `/api/health`, and alerts. No manual step is needed.
4. The workflow run is always marked **failed** when the gate fails — with or
   without a rollback — so a bad deploy is never reported green.

### Fail-safe behaviours

- If the gate itself crashes (bad config, runner problem), the deploy is
  treated as **unverified** and rolled back, unless the override below is set.
- If `/metrics` is unreachable or rejects the token (`METRICS_TOKEN` secret),
  the gate degrades to the health signal only and the alert says so. It does
  not fail the deploy on missing metrics.
- Error-rate counters are read from whichever instance answers each scrape.
  With several App Runner instances a scrape can hop between instances; the
  gate treats a counter that goes backwards as an instance restart. The
  health signal is authoritative — treat the error-rate signal as a
  second opinion, and tune `HEALTH_GATE_MIN_REQUESTS` up if it is noisy.

## Alerts

Both events post to `DEVOPS_ALERT_WEBHOOK_URL` (Slack/Discord), and are also
printed in the run log. If the secret is unset the alert is skipped, never the
deploy outcome.

- **Health check FAILED** — sent the moment the gate fails, before the
  rollback starts. Includes the failing signal and message, how many health
  checks failed, the last status code and **last health response body** (the
  health endpoint reports per-component status, e.g. which of database /
  Horizon is unhealthy), the 5xx rate and request counts, how far into the
  window it failed, the environment and image tag, and the run link. The
  full machine-readable report is uploaded as the `health-gate-report`
  artifact.
- **Automatic rollback completed** — which slot traffic returned from and to,
  and the previous slot's health after the rollback.
- **Automatic rollback FAILED** — page-worthy: traffic could not be restored;
  manual intervention required immediately.

### Root-causing a failed deploy

1. Read the failure alert: the signal tells you *what* tripped; the last
   health body tells you *which dependency* if it was `health_check_failed`.
2. Open the run and download the `health-gate-report` artifact for the full
   counters.
3. The failed slot is still running the bad image and is now idle — inspect
   its App Runner logs before the next deploy overwrites it.

## Manual override: deploys expected to trip a signal

For an intentional deploy that will briefly trip a signal (for example a
migration that causes a short 5xx spike), start the workflow with:

- **`disable_auto_rollback`** = true
- **`override_reason`** = why (required — the run is rejected up front
  without one, so an override is always auditable)

With the override the gate still runs and still alerts, so you keep
visibility, but the pipeline does **not** roll back. The alert states in
plain words that auto-rollback is disabled, why, and that the bad deploy (if
it is one) is still live. The run is still marked failed if the gate fails.
The override applies to that single run only — the next deploy is protected
again by default.

Prefer the override over loosening the thresholds: thresholds protect every
deploy, the override is scoped to one, reasoned, and visible in the alert.

## Tuning

All thresholds are workflow-level `env` values in
`blue-green-deploy.yml` (`HEALTH_GATE_*`); the script also reads
`HEALTH_GATE_REQUEST_TIMEOUT_SECONDS` (default 5). Change them in a reviewed
PR — a threshold change affects every future deploy.

## Scope

This covers the blue-green App Runner pipeline. The Kubernetes canary ramp
(`scripts/canary-ramp.sh`) has its own automatic rollback per stage and is
unchanged.
