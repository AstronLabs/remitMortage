# Log Retention and Cold Storage Archival Policy

## Overview

RemitMortgage implements a multi-tier log retention and archival strategy to optimize storage costs while maintaining compliance requirements and audit trail integrity. This document outlines the architecture, retrieval procedures, SLAs, and cost implications.

## Architecture

### Log Lifecycle: Hot → Warm → Cold → Delete

```
┌─────────────────────────────────────────────────────────────────┐
│                     Log Archival Workflow                        │
└─────────────────────────────────────────────────────────────────┘

┌──────────────────┐       ┌──────────────────┐       ┌─────────────┐
│   HOT STORAGE    │       │  WARM STORAGE    │       │COLD STORAGE │
│                  │       │                  │       │   (Glacier) │
│ Elasticsearch    │──────▶│ Elasticsearch    │──────▶│     S3      │
│  (Primary)       │       │   (Optimized)    │       │   Archive   │
│                  │       │                  │       │             │
│ • Full replicas  │       │ • No replicas    │       │ • Immutable │
│ • Searchable     │       │ • Merged indices │       │ • Encrypted │
│ • High IOPS      │       │ • Read-only      │       │ • Versioned │
│                  │       │                  │       │             │
│ Duration: 0-3d   │       │ Duration: 3-30d  │       │ 30d-7y      │
│ Cost: Premium    │       │ Cost: Standard   │       │ Cost: Low   │
└──────────────────┘       └──────────────────┘       └─────────────┘
       ↓                           ↓                         ↓
  Compliance & Real-Time      Analytical Queries      Long-term Audit
     Investigation          & Troubleshooting           Trail & Compliance
```

## Index Lifecycle Management (ILM) Policy

### Hot Phase (0-3 days)
- **Storage**: Elasticsearch cluster (primary)
- **Replicas**: 1 replica (2 shards total)
- **Actions**:
  - Rollover when index reaches 50GB OR 30 days
  - Set priority to 100 (highest)
- **Use Case**: Real-time log search, incident investigation
- **Performance**: Full-speed queries, optimal IOPS

### Warm Phase (3-30 days)
- **Storage**: Elasticsearch cluster (warmed nodes, if configured)
- **Replicas**: 0 replicas (1 shard)
- **Actions**:
  - Reduce replicas to 0 (after initial warm period)
  - Force merge to single segment
  - Set priority to 50 (medium)
- **Use Case**: Trend analysis, historical troubleshooting
- **Performance**: Read-optimized, reduced write IOPS

### Cold Phase (30-90 days)
- **Storage**: Elasticsearch cluster (read-only)
- **Replicas**: 0 replicas
- **Actions**:
  - Set priority to 0 (lowest)
  - Indices moved to lowest-tier nodes (if tiered architecture)
- **Use Case**: Compliance review, audit trail
- **Performance**: Slower queries (~5-30 second latency)

### Deep Archive (90+ days to 7 years)
- **Storage**: S3 Glacier/Deep Archive
- **Format**: Snapshot-based archive via S3
- **Retrieval**: On-demand via Elasticsearch restore API
- **Use Case**: Long-term compliance retention
- **Performance**: Retrieval takes 1-48 hours (depends on tier)

### Delete Phase (7 years+)
- **Action**: Automatically delete indices
- **Rationale**: Compliance retention window (7 years for financial records)
- **Override**: Manual intervention required to extend

## Automatic Transitions

| Phase | Trigger | Timeline | Action |
|-------|---------|----------|--------|
| Hot   | Index creation | 0d | Create with replicas=1, priority=100 |
| Warm  | Time + Rollover | 3d | Reduce replicas to 0, merge, priority=50 |
| Cold  | Time threshold | 30d | Set priority=0, move to cold nodes |
| Archive | Time threshold | 30d | Snapshot to S3, delete from ES |
| Delete | Time threshold | 7 years (2555d) | Permanent deletion from S3 |

**Configuration Variables** (in `variables.tf`):
- `log_cold_storage_days`: 30 (configurable)
- `log_deep_archive_days`: 90 (configurable)
- `log_retention_years`: 7 (configurable)

---

## Cold Storage Archival Details

### S3 Bucket Configuration

**Location**: `s3://remitmortgage-log-archive-{environment}-{account-id}`

**Properties**:
- **Versioning**: Enabled (for audit trail immutability)
- **Encryption**: AES-256 (server-side)
- **Access Control**: Private (public access blocked)
- **Lifecycle Policy**:
  - **Day 30**: Transition to Glacier (Standard)
  - **Day 90**: Transition to Glacier Deep Archive
  - **Day 2555 (7 years)**: Automatic expiration

### Elasticsearch Snapshots

**Snapshot Repository**: `logs-s3-repository` (in S3 bucket under `elasticsearch-snapshots/`)

**Snapshot Frequency**: Daily at 01:30 UTC

**Retention Policy**:
- Minimum: 5 snapshots (at least 5 days)
- Maximum: 20 snapshots (at most 20 days)
- Expiration: 30 days after creation

**Snapshot Contents**:
- Indices: `logs-*`, `logstash-*`, `remitmortgage-*`
- Global state: Excluded (templates preserved separately)
- Partial: Enabled (continue if some shards unavailable)

---

## Retrieval Process & SLAs

### Scenario 1: Recent Logs (0-3 days, Hot Storage)

**Retrieval Time SLA**: < 1 second

**Steps**:
1. Open Kibana dashboard or use Elasticsearch API
2. Query the desired time range (e.g., `@timestamp: [now-1d TO now]`)
3. Results returned instantly

**Example**:
```bash
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "range": {
        "@timestamp": {
          "gte": "now-1d",
          "lte": "now"
        }
      }
    },
    "size": 1000
  }'
```

---

### Scenario 2: Warm Logs (3-30 days, Warm Storage)

**Retrieval Time SLA**: < 5 seconds

**Steps**:
1. Query via Kibana or Elasticsearch API (same as hot)
2. Elasticsearch retrieves from warm-tier nodes
3. Results returned with slight latency

**Note**: Queries may take slightly longer due to merged segments and lower IOPS.

**Example**:
```bash
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "bool": {
        "must": [
          { "range": { "@timestamp": { "gte": "now-30d", "lte": "now-3d" } } },
          { "match": { "message": "error" } }
        ]
      }
    },
    "size": 5000
  }'
```

---

### Scenario 3: Cold Logs (30-90 days, Cold Storage in Elasticsearch)

**Retrieval Time SLA**: 5-30 seconds

**Steps**:
1. Query via Kibana or Elasticsearch API (same endpoint)
2. Elasticsearch retrieves from lowest-priority cold nodes
3. Search may be slower due to lower-tier hardware

**Considerations**:
- Indices are still in Elasticsearch but with minimal resources
- Queries are possible but slower than warm/hot
- No restoration needed (still searchable in ES)

**Example** (same as warm):
```bash
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "range": {
        "@timestamp": {
          "gte": "now-90d",
          "lte": "now-30d"
        }
      }
    }
  }'
```

---

### Scenario 4: Archived Logs (90 days - 7 years, S3 Glacier Archive)

**Retrieval Time SLA**: 1-48 hours (depending on Glacier tier)

**Architecture**:
- Logs stored as Elasticsearch snapshots in S3 Glacier
- Not directly searchable in Elasticsearch
- Requires restoration to Elasticsearch cluster

**Glacier Tiers**:

| Tier | Retrieval Time | Cost (per GB) | Use Case |
|------|----------------|---------------|----------|
| **Glacier Instant** | 1-3 sec | $0.03/GB | Recent archives (30-90d) |
| **Glacier Flexible** | 3-5 hours | $0.004/GB | Standard compliance (90d+) |
| **Deep Archive** | 12 hours | $0.00099/GB | Long-term retention (1+ year) |

**Configuration** (current):
- Days 30-90: Glacier Instant Retrieval
- Days 90+: Glacier Deep Archive

---

## Restore Procedure from S3 Archive

### Prerequisites
- Elasticsearch cluster has capacity for additional indices
- S3 snapshot repository is registered (`logs-s3-repository`)
- IAM permissions for restoration (included in `elasticsearch_snapshot_role`)

### Step 1: List Available Snapshots

```bash
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/_snapshot/logs-s3-repository/_all" \
  -H "Content-Type: application/json"
```

**Response Example**:
```json
{
  "snapshots": [
    {
      "snapshot": "snapshot-2025-01-15-000001",
      "uuid": "abc123def456",
      "version_id": 7100099,
      "version": "7.10.0",
      "indices": ["logs-2025.01.15", "logs-2025.01.14"],
      "data_streams": [],
      "include_global_state": false,
      "state": "SUCCESS",
      "start_time": "2025-01-15T01:30:00Z",
      "start_time_in_millis": 1705286400000,
      "end_time": "2025-01-15T01:35:00Z",
      "end_time_in_millis": 1705286700000,
      "duration_in_millis": 300000,
      "failures": [],
      "shards": {
        "total": 5,
        "failed": 0,
        "successful": 5
      }
    }
  ]
}
```

### Step 2: Restore Specific Index from Snapshot

```bash
curl -X POST "https://elasticsearch.remitmortgage.dev:9200/_snapshot/logs-s3-repository/snapshot-2025-01-15-000001/_restore" \
  -H "Content-Type: application/json" \
  -d '{
    "indices": "logs-2025.01.10",
    "index_settings": {
      "index.number_of_replicas": 0
    },
    "rename_pattern": "logs-(.+)",
    "rename_replacement": "restored-logs-$1"
  }'
```

**Parameters Explained**:
- `indices`: Which indices to restore from snapshot
- `index_settings`: Override settings (e.g., reduce replicas)
- `rename_pattern/rename_replacement`: Rename during restore to avoid conflicts

### Step 3: Monitor Restoration Progress

```bash
# Check snapshot restoration status
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/_snapshot/logs-s3-repository/snapshot-2025-01-15-000001/_restore" \
  -H "Content-Type: application/json"

# Or monitor index recovery
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/_recovery/restored-logs-2025.01.10" \
  -H "Content-Type: application/json"
```

### Step 4: Query Restored Indices

```bash
curl -X GET "https://elasticsearch.remitmortgage.dev:9200/restored-logs-*/_search" \
  -H "Content-Type: application/json" \
  -d '{
    "query": {
      "match_all": {}
    },
    "size": 100
  }'
```

### Step 5: Cleanup (Optional)

After analysis, delete the restored index to free resources:

```bash
curl -X DELETE "https://elasticsearch.remitmortgage.dev:9200/restored-logs-2025.01.10"
```

---

## Compliance & Audit Trail

### Immutability Guarantees

- **S3 Versioning**: Every snapshot is versioned; cannot be modified or deleted without explicit action
- **Object Lock** (optional): Can be enabled to prevent deletion for a fixed retention period
- **Encryption**: All snapshots encrypted at rest with AES-256
- **Access Logs**: AWS CloudTrail logs all S3 access for audit purposes

### Audit Considerations

1. **Index Deletion Logging**: Elasticsearch logs all index lifecycle transitions to CloudWatch
2. **Snapshot Audit**: All snapshot operations logged to CloudWatch (`/aws/elasticsearch/remitmortgage-snapshots-{env}`)
3. **S3 Access Audit**: AWS CloudTrail captures all S3 snapshot access
4. **Compliance Window**: 7-year retention ensures compliance with financial record-keeping requirements

---

## Cost Analysis

### Storage Cost Breakdown (Monthly Estimate)

**Assumptions**:
- Average log volume: 500 GB/day
- Log retention: 7 years
- AWS Region: us-east-1

#### Hot Storage (Elasticsearch, 0-3 days)

```
Daily ingest: 500 GB
Period: 3 days
Total storage: 500 × 3 × 2 (replicas) = 3,000 GB = 3 TB

Elasticsearch storage cost (r5.large gp3):
  - Per node: ~$0.40/hour = ~$290/month
  - 3 nodes: $870/month
  
Elasticsearch I/O cost (gp3):
  - IOPS (3,000 per node): $0.10 per IOPS per month
  - Throughput (125 MB/s per node): $0.04 per MB/s per month
  - 3 nodes: ~$150/month

Subtotal (Hot): $1,020/month
```

#### Warm Storage (Elasticsearch, 3-30 days)

```
Daily rollover + 27 days historical = 13,500 GB = 13.5 TB
Reduced IOPS + 0 replicas: roughly 50% of hot cost

Estimated cost: $500/month
```

#### Cold Storage (S3 Glacier, 30-90 days)

```
Ingest: 500 GB/day × 60 days = 30,000 GB = 30 TB

S3 Glacier Instant Retrieval:
  - Storage: 30 TB × $0.004/GB = $120/month
  - PUT requests: (60 days × 1 upload/day) × $0.0005 = $0.03
  - GET requests: (estimated 10 retrievals/month) × $0.001 = $0.01

Subtotal (Glacier): $120/month
```

#### Deep Archive (S3 Glacier Deep Archive, 90d-7y)

```
Ingest: 500 GB/day × 7 years = 1,277,500 GB ≈ 1,278 TB

S3 Glacier Deep Archive:
  - Storage: 1,278 TB × $0.00099/GB = $1,263/month
  - PUT requests: (365 × 7 years × 1 upload/day) × $0.0001 = $0.26
  - GET requests: (estimated 5 retrievals/month) × $0.01 = $0.05

Subtotal (Deep Archive): $1,263/month
```

### Total Monthly Cost Estimate

| Tier | Duration | Storage | Cost/Month |
|------|----------|---------|-----------|
| Hot | 0-3d | 3 TB | $1,020 |
| Warm | 3-30d | 13.5 TB | $500 |
| Glacier | 30-90d | 30 TB | $120 |
| Deep Archive | 90d-7y | 1,278 TB | $1,263 |
| **TOTAL** | | **1,324.5 TB** | **$2,903** |

### Cost Comparison: Without Archival

If all logs remained in hot Elasticsearch for 7 years:

```
7 years × 365 days × 500 GB/day × 2 (replicas) = 2.555 PB

Cost: 2.555 PB × $290 (ES storage per month) = $741,450/month
= ~$8.9 million per year ❌

Savings with archival: ~$8.9M/year ✅
```

### Cost Optimization Strategies

1. **Adjust Cold Storage Thresholds**: Change `log_cold_storage_days` from 30 to 7 for faster archival
2. **Reduce Log Volume**: Filter unnecessary debug logs in production
3. **Compress Snapshots**: Snapshots are automatically gzip-compressed
4. **Use Deep Archive Earlier**: Transition to Deep Archive at 60 days instead of 90

---

## Monitoring & Alerting

### CloudWatch Metrics

**Snapshot Health**:
- `SnapshotFailures`: Alert when >= 1 in 1 hour
- `SnapshotDurationMs`: Track snapshot duration trends
- `SnapshotSize`: Monitor S3 growth

**Elasticsearch Health**:
- `DiskUsage`: Alert when >= 80% full
- `JVMMemoryUsage`: Alert when >= 85% full
- `IndexCount`: Track number of indices

### Alert Configuration

```hcl
# Already configured in Terraform
resource "aws_cloudwatch_metric_alarm" "elasticsearch_snapshot_failures" {
  alarm_name          = "remitmortgage-elasticsearch-snapshot-failures"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = "1"
  evaluation_periods  = "1"
  period              = "3600"
  # Notifies on-call team via SNS
}
```

---

## Runbooks

### Runbook 1: Retrieve Logs from Glacier (Compliance Request)

**Trigger**: Legal/audit team requests logs from specific date

**Timeline**: Compliance SLA 48 hours

1. Receive request with date range (e.g., "Q4 2024 transaction logs")
2. Query CloudTrail to find relevant snapshots
3. Initiate restoration from Glacier (see restore procedure above)
4. Wait for retrieval (Glacier: 3-5 hours for Flexible, 1-3 sec for Instant)
5. Restore snapshot to temporary Elasticsearch index
6. Export logs to CSV/JSON for delivery
7. Delete temporary index after 24 hours

---

### Runbook 2: Emergency Index Recovery

**Trigger**: Production index corrupted or accidentally deleted

**Timeline**: RTO 1 hour, RPO 1 day

1. Alert: "Index recovery needed"
2. Identify most recent healthy snapshot
3. Restore snapshot using procedure above (but to production cluster)
4. Verify data integrity and completeness
5. Redirect traffic to restored index
6. Investigate root cause of corruption

---

### Runbook 3: Cost Anomaly Investigation

**Trigger**: CloudWatch alarm for high snapshot costs

**Steps**:
1. Check S3 bucket usage (`aws s3 ls s3://remitmortgage-log-archive-prod`)
2. Verify snapshot retention policy (max 20 snapshots)
3. Check for failed snapshots consuming storage
4. If needed, manually delete old snapshots:
   ```bash
   curl -X DELETE "https://elasticsearch.../\_snapshot/logs-s3-repository/snapshot-old"
   ```

---

## Troubleshooting

### Issue: Snapshots Failing

**Symptoms**: `SnapshotFailures` alarm triggered

**Diagnosis**:
1. Check Elasticsearch cluster health: `GET /_cluster/health`
2. Check S3 bucket permissions: `aws s3api head-bucket --bucket remitmortgage-log-archive-prod`
3. Check IAM role: `arn:aws:iam::ACCOUNT:role/remitmortgage-es-snapshot-role-prod`

**Resolution**:
```bash
# Retry failed snapshot
curl -X POST "https://elasticsearch.../\_snapshot/logs-s3-repository/failed-snapshot/_restore" \
  -d '{"indices": "logs-*"}'

# Verify S3 access
terraform output elasticsearch_snapshot_role_arn
```

### Issue: Slow Queries on Archived Logs

**Symptoms**: Query latency > 30 seconds for cold indices

**Diagnosis**:
- Check if indices are on cold nodes (low priority)
- Verify index is not in the process of being restored

**Resolution**:
- Restore specific index from snapshot for faster access
- Or wait for index to be moved to warm tier (occurs automatically)

### Issue: S3 Storage Growing Unexpectedly

**Symptoms**: S3 bucket size exceeds projections

**Diagnosis**:
1. Check snapshot count: `aws s3 ls s3://remitmortgage-log-archive-prod/elasticsearch-snapshots/`
2. Verify lifecycle policy is applied: `aws s3api get-bucket-lifecycle-configuration --bucket remitmortgage-log-archive-prod`
3. Check for incomplete snapshots: `GET /_snapshot/logs-s3-repository/_all?verbose`

**Resolution**:
```bash
# Delete old snapshots manually
curl -X DELETE "https://elasticsearch.../\_snapshot/logs-s3-repository/snapshot-2024-01-*"

# Verify lifecycle policy enforces deletion
terraform apply -var="log_retention_years=5"  # Shorten retention if appropriate
```

---

## Summary

This log retention and cold-storage archival policy provides:

✅ **Cost Optimization**: 90%+ savings vs. keeping all logs in hot storage
✅ **Compliance**: 7-year retention for regulatory requirements
✅ **Audit Trail**: Immutable S3 versioning + CloudTrail logging
✅ **Accessibility**: Fast retrieval (< 1 sec) for recent logs, on-demand for archives
✅ **Automation**: Fully automated transitions with no manual intervention
✅ **Monitoring**: CloudWatch alarms for failures and anomalies

For questions or to adjust retention policies, update variables in `infrastructure/terraform/elk/variables.tf` and apply Terraform changes.
