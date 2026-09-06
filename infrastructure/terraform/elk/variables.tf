variable "aws_region" {
  description = "AWS region for ELK infrastructure"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name for resource naming"
  type        = string
  default     = "remitmortgage"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for VPC"
  type        = string
  default     = "10.100.0.0/16"
}

variable "availability_zones" {
  description = "List of availability zones"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "elasticsearch_version" {
  description = "Elasticsearch version"
  type        = string
  default     = "7.10"
}

variable "elasticsearch_instance_type" {
  description = "Instance type for Elasticsearch data nodes"
  type        = string
  default     = "t3.medium.elasticsearch"
}

variable "elasticsearch_instance_count" {
  description = "Number of Elasticsearch data nodes"
  type        = number
  default     = 3
}

variable "elasticsearch_volume_size" {
  description = "EBS volume size for each node (GB)"
  type        = number
  default     = 100
}

variable "enable_dedicated_master" {
  description = "Enable dedicated master nodes"
  type        = bool
  default     = true
}

variable "dedicated_master_type" {
  description = "Instance type for dedicated master nodes"
  type        = string
  default     = "t3.small.elasticsearch"
}

variable "dedicated_master_count" {
  description = "Number of dedicated master nodes"
  type        = number
  default     = 3
}

variable "allowed_kibana_cidr" {
  description = "CIDR blocks allowed to access Kibana"
  type        = list(string)
  default     = ["0.0.0.0/0"] # Restrict this in production
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}

variable "log_cold_storage_days" {
  description = "Days before logs transition to cold storage (Glacier)"
  type        = number
  default     = 30
}

variable "log_deep_archive_days" {
  description = "Days before logs transition to deep archive"
  type        = number
  default     = 90
}

variable "log_retention_years" {
  description = "Total log retention period in years (for compliance)"
  type        = number
  default     = 7
}
