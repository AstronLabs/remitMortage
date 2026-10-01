# Runbook Drift Detection

Operational runbooks under `docs/` reference specific Terraform-managed
infrastructure — resource names, ARNs, SNS topics, alert thresholds. As that
infrastructure evolves, those references silently go stale: a renamed App
Runner service, a threshold bumped from `$50` to `$250`, a Lambda function
that no longer exists. An on-call engineer following a stale runbook during
an incident wastes time on instructions that no longer match reality.

The `runbook-drift-detection` scheduled check (`.github/workflows/runbook-drift-detection.yml`,
running `scripts/check-runbook-drift.mjs`) extracts every machine-checkable
claim a runbook makes and compares it against the live Terraform outputs and
state for the infrastructure it describes. This document is the annotation
convention runbook authors write those claims in.

---

## The `runbook-ref` block

Any fenced code block tagged `runbook-ref` is parsed as a set of `key: value`
lines describing one claim the surrounding prose makes about a piece of
infrastructure:

````markdown
```runbook-ref
resource: aws_sns_topic.cost_anomaly_alerts
output: cost_anomaly_alerts_topic_name
expect: remit-mortgage-cost-anomaly-alerts-production
```
````

Place it directly under the sentence or diagram node it backs, so the claim
stays next to the prose it's verifying.

### Fields

| Field | Required | Meaning |
|---|---|---|
| `resource` | one of `resource`/`output` required | The Terraform resource address (as `terraform state list` prints it, e.g. `aws_sns_topic.cost_anomaly_alerts`) this reference is about. Checked for **existence** — if it's no longer in state, the resource was renamed or removed. |
| `output` | one of `resource`/`output` required | The name of a Terraform `output` block whose current value the runbook depends on (e.g. a threshold, an ARN, a topic name). Checked for **existence and value**. |
| `expect` | required if `output` is set | The literal value the runbook currently states — a resource name, ARN, or number, written exactly as it should compare to the live output value (compared as trimmed strings). |
| `root` | no (default `devops`) | Which Terraform root the reference lives under: `devops` or `devops/terraform` (matching the roots in `terraform-drift-detection.yml`). |
| `environment` | no (default `production`) | Which environment/workspace to read the output/state from: `dev`, `staging`, or `production`. Runbooks describe incident response, so `production` is the default; override for an environment-specific doc. |
| `note` | no | Freeform context for humans; ignored by the checker. |

A block needs `resource`, `output`, or both:

- **`resource` only** — an existence check. Use this for a claim like "the
  Lambda function `remit-mortgage-cost-anomaly-notifier-production` handles
  this" where the name itself isn't exposed as a Terraform output but you
  still want to know if the resource disappears.
- **`output` only** (with `expect`) — a value check against a stable,
  intentionally-exposed Terraform output. Prefer this whenever the
  infrastructure already has (or can cheaply get) an output — it's more
  precise than an existence check and catches renames Terraform's `state
  list` output format might otherwise not surface clearly.
- **Both** — the resource must exist *and* the output must still match. Use
  this for something as identity-sensitive as an ARN.

### Example: a threshold

````markdown
Alerts fire once anomaly impact reaches **$50 USD**.

```runbook-ref
output: cost_anomaly_threshold_usd
expect: 50
```
````

If someone bumps `cost_anomaly_threshold_amount` in `devops/variables.tf` to
`250` without updating this sentence, the next scheduled run flags it.

---

## What counts as drift

| Situation | Result |
|---|---|
| `resource` address is in `terraform state list` for its (root, environment) | OK |
| `resource` address is **not** in state | **Flagged** — renamed or removed |
| `output` exists and its value (trimmed) equals `expect` | OK |
| `output` no longer exists | **Flagged** — the claim can no longer be verified |
| `output` exists but its value differs from `expect` | **Flagged** — value changed |
| A `runbook-ref` block is missing both `resource` and `output`, or sets `output` without `expect` | **Flagged** as a parse error (fix the annotation) |

Runbooks with **no** `runbook-ref` blocks are never flagged — annotation is
opt-in per claim, not a requirement for every runbook.

---

## Running it locally

```bash
# Requires terraform + AWS credentials with read access, same as
# scripts/detect-prisma-drift.sh's live-DB mode.
node scripts/check-runbook-drift.mjs

# Point at a different docs directory (mostly for testing the tool itself)
node scripts/check-runbook-drift.mjs path/to/docs
```

Exit codes mirror `backend/scripts/detect-prisma-drift.sh`:

| Code | Meaning |
|---|---|
| `0` | No drift, no malformed blocks |
| `1` | Couldn't read Terraform state/outputs for a referenced (root, environment), or a block is malformed and there's no drift to report alongside it |
| `2` | Drift detected in at least one `runbook-ref` |

The pure parsing/comparison logic (`extractRunbookRefs`, `compareRefToTerraform`,
`runDriftCheck`) is unit tested in `scripts/check-runbook-drift.test.mjs`
against fixture Terraform data — no live `terraform`/AWS calls are needed to
run that suite:

```bash
node --test scripts/check-runbook-drift.test.mjs
```

---

## The scheduled check

`.github/workflows/runbook-drift-detection.yml` runs daily, discovers every
(root, environment) pair referenced anywhere under `docs/`, runs `terraform
init` + `terraform output -json` + `terraform state list` for each, and
compares. On drift it opens a GitHub issue and posts to the same
`DEVOPS_ALERT_WEBHOOK_URL` used by `terraform-drift-detection.yml` — see that
workflow and `docs/terraform-drift-remediation.md` for the alerting and
remediation pattern this mirrors.
