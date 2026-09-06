variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "db_username" {
  description = "Username for the PostgreSQL database"
  type        = string
  default     = "postgres"
}

variable "db_password" {
  description = "Password for the PostgreSQL database"
  type        = string
  sensitive   = true
}

variable "database_secret_arn" {
  description = "Secrets Manager ARN containing the database connection URL"
  type        = string
  sensitive   = true
  default     = ""
}

variable "sendgrid_secret_arn" {
  description = "Secrets Manager ARN containing the SendGrid API key"
  type        = string
  sensitive   = true
  default     = ""
}

variable "secrets_rotation_lambda_arn" {
  description = "Optional Lambda ARN implementing Secrets Manager rotation"
  type        = string
  default     = ""
}

variable "secrets_rotation_days" {
  description = "Rotation interval; old credentials remain valid for the provider grace window"
  type        = number
  default     = 30
}

variable "app_image" {
  description = "ECR Image URI for the App Runner service"
  type        = string
  default     = "public.ecr.aws/nginx/nginx:latest" # Placeholder
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "dev"
}

variable "otel_exporter_otlp_endpoint" {
  description = "OpenTelemetry collector OTLP receiver HTTP/HTTPS endpoint"
  type        = string
  default     = ""
}

variable "otel_traces_sampler_ratio" {
  description = "OpenTelemetry sampling ratio for traces (float between 0.0 and 1.0)"
  type        = string
  default     = "1.0"
}

# ── Geo-DNS & CDN ───────────────────────────────────────────────────────

variable "app_domain_name" {
  description = "Main application domain (apex) for the frontend"
  type        = string
  default     = "remitmortgage.com"
}

variable "www_domain_name" {
  description = "www subdomain (empty string to disable)"
  type        = string
  default     = "www.remitmortgage.com"
}

variable "frontend_origin_domain" {
  description = "Origin domain for the Next.js application server (App Runner / ALB DNS name)"
  type        = string
}

variable "certificate_arn" {
  description = "ACM certificate ARN in us-east-1 for the CloudFront distribution (must cover app_domain_name and www_domain_name)"
  type        = string
}

# ── AWS Cost Anomaly Detection & Alerting ───────────────────────────────

variable "cost_anomaly_threshold_amount" {
  description = "Absolute dollar impact threshold ($) for triggering AWS cost anomaly alerts"
  type        = number
  default     = 50
}

variable "slack_webhook_url" {
  description = "Slack Incoming Webhook URL for posting cost anomaly alerts to #devops"
  type        = string
  sensitive   = true
  default     = ""
}

variable "cost_anomaly_eval_frequency" {
  description = "Frequency for cost anomaly evaluation and notifications (IMMEDIATE, DAILY, or WEEKLY)"
  type        = string
  default     = "IMMEDIATE"
}

