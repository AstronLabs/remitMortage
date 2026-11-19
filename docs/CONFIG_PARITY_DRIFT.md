# Staging / Production Configuration Parity Drift

`config-parity-drift.yml` runs every 6 hours, snapshots the non-secret configuration of staging and production, and reports differences that are not on the allowlist.

## What is compared

Collected by `scripts/config-parity-drift.mjs collect` (App Runner service `remit-mortgage-api-<env>`):

| Key prefix | Source |
| --- | --- |
| `env.*` | Runtime environment variables |
| `image.*` | Image repository and tag |
| `runtime.*` | CPU, memory, port |
| `flag.*` | SSM parameters under `/remitmortgage/<env>/flags/` (SecureString skipped) |

Secrets are never collected: App Runner exposes secret references separately, and any key that looks secret (`*SECRET*`, `*TOKEN*`, `*KEY`, `*PASSWORD*`, …) or value with embedded credentials is dropped before the snapshot is written.

## Allowlist

`devops/config-parity-allowlist.json` lists differences that are expected. Add an entry through a reviewed PR with a `reason`. Use `expect: { staging, production }` to tolerate a difference only while both environments keep those exact values, so an allowlisted setting that drifts further is still reported. `key` accepts a trailing `*`.

## Alerts and history

- Only **new** drift alerts (team channel via `DEVOPS_ALERT_WEBHOOK_URL`, plus a GitHub issue). Drift that is already known does not re-alert; drift that was resolved and returns does.
- `history.json` on the `config-drift-history` branch stores `firstSeen`, `lastSeen`, `status` and `resolvedAt` per key.
- The run fails while unexpected drift exists, and the report is in the run summary.

## Local check

```bash
node --test scripts/config-parity-drift.test.mjs
node scripts/config-parity-drift.mjs compare --staging staging.json --production production.json
```
