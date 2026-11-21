# Multi-Region Failover Routing Configuration
#
# This Terraform module provisions geo-distributed DNS failover routing
# with automated health checks across multiple cloud provider regions.
# Enables automatic failover when indexing nodes become unavailable.

# Configure Terraform provider versions
terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
  }
}

# Standard cost-allocation tags, applied to every taggable resource through
# the provider so individual resources cannot forget them. Enforced in CI by
# devops/policy/tags (see docs/COST_ALLOCATION_TAG_POLICY.md).
locals {
  required_tags = {
    Service     = "indexer"
    Environment = var.environment
    Owner       = var.owner
    CostCenter  = var.cost_center
  }
}

provider "aws" {
  region = var.primary_region

  default_tags {
    tags = local.required_tags
  }
}

provider "aws" {
  alias  = "secondary"
  region = var.secondary_region

  default_tags {
    tags = local.required_tags
  }
}

# ─────────────────────────────────────────────────────────────────────────
# Primary Region: Indexing Infrastructure
# ─────────────────────────────────────────────────────────────────────────

resource "aws_route53_health_check" "primary_indexer" {
  ip_address        = aws_instance.primary_indexer.public_ip
  port              = var.api_port
  type              = "HTTP"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name = "primary-indexer-health-check"
  }
}

resource "aws_route53_health_check" "secondary_indexer" {
  provider = aws.secondary
  
  ip_address        = aws_instance.secondary_indexer[0].public_ip
  port              = var.api_port
  type              = "HTTP"
  resource_path     = "/health"
  failure_threshold = 3
  request_interval  = 30

  tags = {
    Name = "secondary-indexer-health-check"
  }
}

# ─────────────────────────────────────────────────────────────────────────
# Route53 Failover DNS Configuration
# ─────────────────────────────────────────────────────────────────────────

resource "aws_route53_zone" "main" {
  name = var.domain_name

  tags = {
    Name = "remit-mortgage-zone"
  }
}

# Primary DNS record pointing to primary region
resource "aws_route53_record" "indexer_primary" {
  zone_id       = aws_route53_zone.main.zone_id
  name          = "indexer.${var.domain_name}"
  type          = "A"
  ttl           = 60
  set_identifier = "primary-${var.primary_region}"
  
  failover_routing_policy {
    type = "PRIMARY"
  }

  records            = [aws_instance.primary_indexer.public_ip]
  health_check_id    = aws_route53_health_check.primary_indexer.id

  depends_on = [aws_route53_zone.main]
}

# Secondary failover DNS record pointing to secondary region
resource "aws_route53_record" "indexer_secondary" {
  zone_id       = aws_route53_zone.main.zone_id
  name          = "indexer.${var.domain_name}"
  type          = "A"
  ttl           = 60
  set_identifier = "secondary-${var.secondary_region}"
  
  failover_routing_policy {
    type = "SECONDARY"
  }

  records            = [aws_instance.secondary_indexer[0].public_ip]
  health_check_id    = aws_route53_health_check.secondary_indexer.id

  depends_on = [aws_route53_zone.main]
}

# ─────────────────────────────────────────────────────────────────────────
# Computed DNS Failover Routing Policy
# ─────────────────────────────────────────────────────────────────────────

# Weighted routing for multi-region load balancing
resource "aws_route53_record" "indexer_weighted_primary" {
  zone_id       = aws_route53_zone.main.zone_id
  name          = "indexer-lb.${var.domain_name}"
  type          = "A"
  ttl           = 60
  set_identifier = "primary-weighted"
  
  weighted_routing_policy {
    weight = 100
  }

  records            = [aws_instance.primary_indexer.public_ip]
  health_check_id    = aws_route53_health_check.primary_indexer.id

  depends_on = [aws_route53_zone.main]
}

resource "aws_route53_record" "indexer_weighted_secondary" {
  zone_id       = aws_route53_zone.main.zone_id
  name          = "indexer-lb.${var.domain_name}"
  type          = "A"
  ttl           = 60
  set_identifier = "secondary-weighted"
  
  weighted_routing_policy {
    weight = 50
  }

  records            = [aws_instance.secondary_indexer[0].public_ip]
  health_check_id    = aws_route53_health_check.secondary_indexer.id

  depends_on = [aws_route53_zone.main]
}

# ─────────────────────────────────────────────────────────────────────────
# Geolocation-Based Routing
# ─────────────────────────────────────────────────────────────────────────

# Default (worldwide except specific regions) routes to primary
resource "aws_route53_record" "indexer_geoloc_default" {
  zone_id       = aws_route53_zone.main.zone_id
  name          = "indexer-geo.${var.domain_name}"
  type          = "A"
  ttl           = 60
  set_identifier = "location-default"
  
  geolocation_routing_policy {
    country = "*"
  }

  records            = [aws_instance.primary_indexer.public_ip]
  health_check_id    = aws_route53_health_check.primary_indexer.id

  depends_on = [aws_route53_zone.main]
}

# ─────────────────────────────────────────────────────────────────────────
# CloudWatch Alarms for Failover Triggers
# ─────────────────────────────────────────────────────────────────────────

resource "aws_cloudwatch_metric_alarm" "primary_unhealthy" {
  alarm_name          = "primary-indexer-unhealthy"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "HealthCheckStatus"
  namespace           = "AWS/Route53"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  alarm_description   = "Alert when primary indexer health check fails"
  alarm_actions       = [aws_sns_topic.failover_alerts.arn]

  dimensions = {
    HealthCheckId = aws_route53_health_check.primary_indexer.id
  }
}

# SNS Topic for failover notifications
resource "aws_sns_topic" "failover_alerts" {
  name = "indexer-failover-alerts"

  tags = {
    Name = "failover-notification-topic"
  }
}

resource "aws_sns_topic_subscription" "failover_email" {
  topic_arn = aws_sns_topic.failover_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ─────────────────────────────────────────────────────────────────────────
# Outputs
# ─────────────────────────────────────────────────────────────────────────

output "indexer_primary_dns" {
  value       = aws_route53_record.indexer_primary.fqdn
  description = "Primary failover DNS endpoint"
}

output "indexer_secondary_dns" {
  value       = aws_route53_record.indexer_secondary.fqdn
  description = "Secondary failover DNS endpoint"
}

output "indexer_lb_dns" {
  value       = aws_route53_record.indexer_weighted_primary.fqdn
  description = "Load-balanced DNS endpoint"
}

output "indexer_geo_dns" {
  value       = aws_route53_record.indexer_geoloc_default.fqdn
  description = "Geolocation-aware DNS endpoint"
}

output "health_check_status" {
  value = {
    primary   = aws_route53_health_check.primary_indexer.id
    secondary = aws_route53_health_check.secondary_indexer.id
  }
  description = "Health check IDs for monitoring"
}
