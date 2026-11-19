# Deployment Freeze Windows

Production deploys are blocked during sensitive periods (month-end processing, an active incident, year-end) by a gate in `blue-green-deploy.yml`, driven by a version-controlled calendar.

## Calendar

`devops/deploy-freeze-calendar.json` (UTC; a window is active from `start` inclusive to `end` exclusive):

| Field | Meaning |
| --- | --- |
| `authorizedOverriders` | GitHub logins allowed to override a freeze |
| `minOverrideReasonLength` | Minimum characters for an override reason |
| `monthEnd` | Recurring freeze over the last `lastDays` days of every month |
| `windows[]` | One-off windows: `id`, `name`, `reason`, `start`, `end`, `environments`, optional `allowOverride: false` for a hard freeze |

Add an incident hold by opening a PR (or, in an emergency, pushing to the calendar) with a new window. Edits are reviewed like any code change; `node scripts/deploy-freeze-gate.mjs validate` lints the file in CI.

## What happens on deploy

The `Deploy Freeze Gate` job runs before any slot is touched and prints the freeze status in the run summary:

- 🟢 no freeze for the target environment: deploy proceeds.
- 🔴 freeze active: the job fails and nothing deploys.
- 🟠 freeze active and an authorized override recorded: deploy proceeds.

## Emergency override

Re-run the workflow with `freeze_override_reason` set. It is honored only if the triggering GitHub user is in `authorizedOverriders`, the reason is long enough, and the window allows overrides. Each override is logged with the person, reason, window and time: in the run summary, in the `freeze-override-log-<run id>` artifact (kept 400 days), and in the team channel via `DEVOPS_ALERT_WEBHOOK_URL`.

## Announcements

`deploy-freeze.yml` runs on weekdays at 09:00 UTC and posts any active or upcoming (next 72h) freezes to the team channel.
