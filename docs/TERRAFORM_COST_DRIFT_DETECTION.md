# Terraform Cost Drift Detection

Infracost (`infracost.yml`, `.github/workflows/infracost.yml`) estimates what a Terraform change *should* cost before it merges. Nothing in that check notices if real billing later runs away from the estimate — for example an autoscaling misconfiguration that keeps far more App Runner instances alive than planned. The **Terraform Cost Drift Detection** workflow (`.github/workflows/cost-drift-detection.yml`) closes that gap by comparing actual monthly AWS spend per service against the Infracost estimate recorded at the last deploy.

It complements, rather than replaces, AWS Cost Anomaly Detection (`devops/cost-anomaly.tf`, [runbook](COST_ANOMALY_TRIAGE_RUNBOOK.md)): anomaly detection compares spend with *historical* spend, so a service that has been overspending since the day it launched looks normal to it. Drift detection compares spend with what the Terraform config *was expected* to cost.

## How it works

```
push to main (Terraform change)            3rd of every month (06:00 UTC)
        │                                             │
        ▼                                             ▼
 record-baseline                                detect-drift
 infracost breakdown ──► artifact  ─────────►  download latest baseline
 (infracost-cost-baseline, 90 days)             aws ce get-cost-and-usage (last month,
                                                 grouped by SERVICE, Environment tag)
                                                        │
                                                        ▼
                                              scripts/cost_drift_check.py
                                                        │
                                   drift? ──► Slack/Discord + GitHub issue (label cost-drift)
                                                        │
                                                  job summary + report artifact
```

### Recording the baseline

Every push to `main` that changes `devops/**.tf`, `infrastructure/terraform/**.tf` or `infracost.yml` is a Terraform deploy. The `record-baseline` job runs `infracost breakdown` for every project in `infracost.yml` and uploads the JSON as the `infracost-cost-baseline` artifact. The monthly check always uses the artifact from the **most recent successful deploy run**.

Artifacts are kept for 90 days. If there has been no Terraform change for longer than that, the baseline has expired — but then the current `main` config is exactly what is deployed, so the job regenerates the breakdown from `main` and notes this in the run.

### Comparing against actual billing

The `detect-drift` job pulls the previous calendar month's `UnblendedCost` from AWS Cost Explorer, grouped by the `SERVICE` dimension and filtered to resources tagged `Environment=<COST_DRIFT_ENVIRONMENT>` (default `production`). `scripts/cost_drift_check.py` then:

1. Maps each Infracost resource to an AWS service via its Terraform resource type (`SERVICE_BY_RESOURCE_PREFIX`, longest prefix wins — e.g. `aws_db_instance` → `Amazon Relational Database Service`, `aws_nat_gateway` → `EC2 - Other`) and sums the estimate per service.
2. Classifies every service:

| Status | Meaning | Alerts? |
|---|---|---|
| `DRIFT` | Actual > estimate × (1 + threshold%) **and** actual − estimate ≥ `COST_DRIFT_MIN_DELTA_USD` | Yes |
| `OK` | Within the threshold (including under-spend) | No |
| `UNESTIMATED` | Spend with no Infracost estimate — mostly usage-based charges (data transfer, requests, tax) Infracost cannot price | No, reported only |

Resource types that carry an estimate but have no service mapping are listed at the bottom of the report so they can be added to the mapping rather than silently ignored.

The script exits `0` (no drift), `2` (drift) or `1` (bad input), like `terraform plan -detailed-exitcode`.

## Configuration

Set in the `env:` block of `.github/workflows/cost-drift-detection.yml`:

| Variable | Default | Purpose |
|---|---|---|
| `COST_DRIFT_THRESHOLD_PCT` | `25` | Percent over the estimate at which a service is flagged. Can be overridden per manual run (`threshold_pct` input). |
| `COST_DRIFT_MIN_DELTA_USD` | `10` | Minimum dollar overrun to flag, so a $0.40 service billing $1.10 does not raise an alert. |
| `COST_DRIFT_ENVIRONMENT` | `production` | `Environment` tag value Cost Explorer is filtered to. Can be overridden per manual run (`environment` input). |

Secrets used: `INFRACOST_API_KEY`, `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (needs `ce:GetCostAndUsage`), and optionally `DEVOPS_ALERT_WEBHOOK_URL` (the same webhook as Terraform drift detection).

> **Prerequisite:** the `Environment` tag must be activated as a [cost allocation tag](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html) in the AWS Billing console, otherwise the Cost Explorer filter returns no data. Tags only apply to spend incurred after activation.

## Running it manually

- **In CI:** Actions → *Terraform Cost Drift Detection* → *Run workflow*, optionally with a different threshold or environment.
- **Locally:**

```bash
infracost breakdown --config-file=infracost.yml --format=json --out-file=baseline.json
aws ce get-cost-and-usage \
  --time-period Start=2026-08-01,End=2026-09-01 \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --filter '{"Tags":{"Key":"Environment","Values":["production"]}}' > actuals.json
python3 scripts/cost_drift_check.py --baseline baseline.json --actuals actuals.json --threshold-pct 25
```

Script tests: `python3 -m unittest discover -s scripts -p "test_cost_drift_check.py"` (also run automatically on PRs that touch the script).

## Triage when an alert fires

One issue is opened per billing month (label `cost-drift`); re-runs in the same month do not duplicate it.

1. Open the linked run; the job summary shows the per-service table and the report artifact includes the raw Cost Explorer and Infracost JSON.
2. For each `DRIFT` service, check whether the extra spend is expected:
   - **Scaling beyond plan** (App Runner/ECS instance counts, RDS/ElastiCache node sizes): compare live capacity with the Terraform config — the [Terraform drift runbook](terraform-drift-remediation.md) covers out-of-band changes.
   - **Usage the estimate did not model**: Infracost prices usage-based resources with zero or default usage unless a usage file is supplied. If real usage is legitimately higher, add an Infracost usage file (`usage_file:` in `infracost.yml`) with realistic values so future estimates match.
   - **A resource outside Terraform** sharing the `Environment` tag: import it into Terraform or remove it.
3. If the overspend is intended, deploy a Terraform change (or usage-file update) so the next baseline reflects it, then close the issue.
