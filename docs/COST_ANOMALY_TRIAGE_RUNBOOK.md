# AWS Cost Anomaly Triage & Resolution Runbook

## Overview & Architecture

To prevent runaway cloud infrastructure spend caused by misconfigured auto-scaling, rogue loops, or forgotten resources, the RemitMortgage infrastructure uses **AWS Cost Anomaly Detection** monitored via Terraform (`devops/cost-anomaly.tf`).

### Monitoring Pipeline

```
┌──────────────────────────────────────┐
│ AWS Cost Anomaly Monitors            │
│  - Dimensional (All AWS Services)    │
│  - Tag-Based (Environment=var.env)  │
└──────────────────┬───────────────────┘
                   │ Anomaly Total Impact >= $50
                   ▼
┌──────────────────────────────────────┐
│ AWS SNS Topic                        │
│ (remit-mortgage-cost-anomaly-alerts) │
└──────────────────┬───────────────────┘
                   │
                   ▼
┌──────────────────────────────────────┐
│ Lambda Slack Notifier                │
│ (remit-mortgage-cost-anomaly-      │
│  notifier-dev)                       │
└──────────────────┬───────────────────┘
                   │ Formatted Block Kit Payload
                   ▼
┌──────────────────────────────────────┐
│ Slack Channel: #devops               │
└──────────────────────────────────────┘
```

---

## Slack Alert Anatomy

When a cost anomaly exceeds the configured impact threshold (default: **$50 USD**), a Slack alert is posted to `#devops` containing all details required to begin triage without manual lookup:

- **Environment**: Target environment (`DEV`, `STAGING`, `PROD`).
- **Affected Service**: Name of the AWS service (e.g., `Amazon Elastic Container Service / App Runner`, `Amazon Relational Database Service`).
- **Cost Impact (Delta)**: Absolute dollar spike above expected baseline (e.g., `+$125.50`).
- **Expected vs. Actual Spend**: Expected spend baseline (e.g., `$34.50`) vs actual spend (e.g., `$160.00` / `+350.2%`).
- **AWS Account & Region**: Linked AWS account ID and deployment region.
- **Usage Type Detail**: Specific usage metric (e.g., `AppRunner-Provisioned-vCPU-Hours`, `RDS:GP2-Storage`).
- **Detection Window & Anomaly ID**: Time window and unique AWS Anomaly ID with a direct button link to the AWS Cost Explorer Anomaly Console.

---

## Step-by-Step Triage Workflow

### Phase 1: Initial Assessment (SLA: < 15 Minutes)

1. **Acknowledge the Slack Alert**: Post a reaction (`👀` or `triage-in-progress`) on the alert message in `#devops`.
2. **Evaluate Impact & Blast Radius**:
   - Check **Environment**: Is this `dev`, `staging`, or `prod`?
   - Check **Cost Delta**: Is the spike ongoing (continuous hourly spend) or a one-off batch spike?
3. **Open AWS Cost Explorer Anomaly Console**: Click the **"View Anomaly in Console"** button on the Slack alert.

---

### Phase 2: Root Cause Identification

1. **Review Anomaly Details in Console**:
   - Inspect the **Root Cause** section for specific linked account IDs, usage types, and resource tags.
2. **Correlate with Recent Deployments**:
   - Check recent GitHub Actions workflow runs or Terraform applies on branch `main` or release tags.
3. **Check Service Metrics in CloudWatch**:
   - **App Runner**: Check CPU utilization, memory utilization, and active instance count.
   - **RDS PostgreSQL**: Check `CPUUtilization`, `DatabaseConnections`, `ReadIOPS`, and `FreeStorageSpace`.
   - **ElastiCache Redis**: Check `EngineCPUUtilization` and `CurrConnections`.
4. **Inspect CloudTrail Event History**:
   - Query CloudTrail for `Create*`, `Update*`, or `Run*` operations during the detection window to identify who or what created the resources.

---

### Phase 3: Service-Specific Mitigation Runbooks

#### Scenario A: App Runner / Container Auto-Scaling Runaway

- **Symptom**: `UsageType` shows `AppRunner-Provisioned-vCPU-Hours` or `AppRunner-Container-Requests` spiking unexpectedly.
- **Probable Causes**: DDoS attack, infinite retry loop in frontend/backend client, or misconfigured auto-scaling max concurrency limits.
- **Mitigation Steps**:
  1. Inspect App Runner service metrics and request logs.
  2. If caused by traffic volume, apply IP rate limiting via CloudFront WAF (`devops/cloudfront.tf`).
  3. If caused by auto-scaling misconfiguration, temporarily cap `max_size` in `aws_apprunner_service.app`:
     ```hcl
     # devops/main.tf (or auto-scaling configuration)
     max_size = 2 # Temporarily restrict max instances
     ```
  4. Apply Terraform changes: `terraform apply`.

#### Scenario B: RDS PostgreSQL Database Spike / Storage Runaway

- **Symptom**: `UsageType` shows `RDS:GP3-Storage` or `RDS:ChargedIOPS` or instance class upgrades.
- **Probable Causes**: Unindexed queries causing excessive disk I/O, rogue transaction logs, or runaway table growth.
- **Mitigation Steps**:
  1. Connect to PostgreSQL instance and query long-running transactions:
     ```sql
     SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
     FROM pg_stat_activity
     WHERE state != 'idle' ORDER BY duration DESC;
     ```
  2. Cancel runaway queries:
     ```sql
     SELECT pg_cancel_backend(<pid>);
     ```
  3. Verify database storage autoscale threshold in `aws_db_instance.postgres`.

#### Scenario C: S3 & ECR Storage / Data Transfer Leakage

- **Symptom**: `UsageType` shows `DataTransfer-Out-Bytes` or `ECR-Storage-GB`.
- **Probable Causes**: Public access data harvesting, uncompressed artifact upload loops, or missing container image lifecycle policy.
- **Mitigation Steps**:
  1. Inspect S3 bucket access logs or CloudFront access logs for bandwidth leaks.
  2. Enforce ECR repository lifecycle policy to prune untagged images older than 7 days.
  3. Verify S3 lifecycle configuration expires temporary multipart uploads.

#### Scenario D: Recursive Lambda / Microservice Invocation Loop

- **Symptom**: `UsageType` shows `Lambda-GB-Second` or `Invocations` spiking exponentially.
- **Probable Causes**: Lambda function triggered by an S3 or SNS event publishing back to the same event source.
- **Mitigation Steps**:
  1. Immediately set reserved concurrency to `0` (emergency kill switch):
     ```bash
     aws lambda put-function-concurrency \
       --function-name remit-mortgage-cost-anomaly-notifier-dev \
       --reserved-concurrent-executions 0
     ```
  2. Fix event loop logic and re-enable concurrency.

---

### Phase 4: Resolution & Post-Incident Review

1. **Verify Cost Normalization**: Monitor AWS Cost Explorer hourly spend to confirm the delta returns to baseline.
2. **Update Alert Reaction**: Change Slack reaction from `👀` to `✅` and post a brief summary in `#devops`:
   > **Resolved**: Cost anomaly on `App Runner` caused by high autoscaling max instances during load test. Capped max instances to 2 and updated WAF rate limit. Total impact: +$62.00.
3. **Adjust Thresholds if Needed**: If the alert was a false positive driven by legitimate traffic growth, update `cost_anomaly_threshold_amount` in `devops/variables.tf` via pull request.

---

## Testing & Validating Anomaly Alerts

To manually test and verify Slack alert formatting without waiting for a real AWS cost anomaly event, publish a test SNS message:

```bash
aws sns publish \
  --topic-arn "arn:aws:sns:us-east-1:123456789012:remit-mortgage-cost-anomaly-alerts-dev" \
  --message '{
    "accountId": "123456789012",
    "anomalyId": "test-anomaly-uuid-12345",
    "anomalyStartDate": "2026-08-25T08:00:00Z",
    "impact": {
      "maxImpact": 125.50,
      "totalImpactPercentage": 350.25,
      "totalActualSpend": 160.00,
      "totalExpectedSpend": 34.50
    },
    "rootCauses": [
      {
        "service": "Amazon Elastic Container Service / App Runner",
        "region": "us-east-1",
        "usageType": "AppRunner-Provisioned-vCPU-Hours"
      }
    ]
  }'
```

Verify that the Slack message arrives in `#devops` formatted with service details, expected vs actual spend, cost delta, and interactive console button.

---

## Infrastructure References

The resource names and threshold cited above (`dev` environment, `devops/cost-anomaly.tf`)
are checked against live Terraform state/outputs by the scheduled runbook
drift check — see [`RUNBOOK_DRIFT_DETECTION.md`](RUNBOOK_DRIFT_DETECTION.md)
for the `runbook-ref` annotation convention.

```runbook-ref
resource: aws_sns_topic.cost_anomaly_alerts
output: cost_anomaly_alerts_topic_name
expect: remit-mortgage-cost-anomaly-alerts-dev
root: devops
environment: dev
```

```runbook-ref
resource: aws_lambda_function.cost_anomaly_slack_notifier
output: cost_anomaly_notifier_function_name
expect: remit-mortgage-cost-anomaly-notifier-dev
root: devops
environment: dev
note: the Lambda that formats and posts the Slack alert
```

```runbook-ref
output: cost_anomaly_threshold_usd
expect: 50
root: devops
environment: dev
note: the "Anomaly Total Impact >= $50" threshold in the monitoring pipeline diagram above
```
