# Elasticsearch Snapshot Repository Configuration for S3 Cold Storage Archival
# This configures Elasticsearch to store snapshots in S3 for disaster recovery
# and long-term log archival to cold storage

# Register S3 Snapshot Repository in Elasticsearch
resource "elasticsearch_snapshot_repository" "logs_s3_repository" {
  name = "logs-s3-repository"

  type = "s3"

  settings = {
    bucket           = aws_s3_bucket.log_archive.id
    base_path        = "elasticsearch-snapshots"
    region           = var.aws_region
    compress         = true
    server_side_encryption = true
    buffer_size      = "1gb"
    max_restore_bytes_per_sec = "40mb"
    max_snapshot_bytes_per_sec = "40mb"
  }

  depends_on = [
    aws_s3_bucket.log_archive,
    aws_iam_role.elasticsearch_snapshot_role
  ]
}

# Snapshot Lifecycle Policy
resource "elasticsearch_snapshot_lifecycle_policy" "logs_snapshot_policy" {
  name = "logs-daily-snapshot-policy"

  policy = jsonencode({
    schedule            = "0 30 1 * * ?"  # Daily at 01:30 UTC
    repository          = elasticsearch_snapshot_repository.logs_s3_repository.name
    retention           = {
      expire_after = "30d"
      min_count    = 5
      max_count    = 20
    }
    indices             = "logs-*,logstash-*"
    include_global_state = false
    partial             = true
    skip_unavailable    = true
  })

  depends_on = [elasticsearch_snapshot_repository.logs_s3_repository]
}

# CloudWatch Alarm for failed snapshots
resource "aws_cloudwatch_metric_alarm" "elasticsearch_snapshot_failures" {
  alarm_name          = "${var.project_name}-elasticsearch-snapshot-failures"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = "1"
  metric_name         = "SnapshotFailures"
  namespace           = "AWS/Elasticsearch"
  period              = "3600"
  statistic           = "Sum"
  threshold           = "1"
  alarm_description   = "Alert when Elasticsearch snapshots fail"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DomainName = aws_elasticsearch_domain.elk_cluster.domain_name
  }
}

# CloudWatch Log Group for Snapshot Activity
resource "aws_cloudwatch_log_group" "elasticsearch_snapshot_logs" {
  name              = "/aws/elasticsearch/${var.project_name}-snapshots-${var.environment}"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "${var.project_name}-elasticsearch-snapshots"
    Environment = var.environment
  }
}

# CloudWatch Log Resource Policy (if needed for cross-account access)
resource "aws_cloudwatch_log_resource_policy" "elasticsearch_log_policy" {
  policy_name = "${var.project_name}-elasticsearch-logs-policy"

  policy_text = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "es.amazonaws.com"
        }
        Action   = "logs:PutLogEvents"
        Resource = "${aws_cloudwatch_log_group.elasticsearch_snapshot_logs.arn}:*"
      }
    ]
  })
}

output "snapshot_repository_name" {
  value       = elasticsearch_snapshot_repository.logs_s3_repository.name
  description = "Name of the Elasticsearch snapshot repository"
}

output "snapshot_lifecycle_policy_name" {
  value       = elasticsearch_snapshot_lifecycle_policy.logs_snapshot_policy.name
  description = "Name of the snapshot lifecycle policy"
}
