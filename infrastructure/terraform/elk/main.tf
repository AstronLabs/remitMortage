terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    bucket         = "remit-mortgage-terraform-state"
    key            = "infrastructure/elk/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "remit-mortgage-terraform-locks"
    encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region
}

# VPC for ELK Stack
resource "aws_vpc" "elk_vpc" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.project_name}-elk-vpc"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Private subnets for Elasticsearch nodes
resource "aws_subnet" "elk_private_subnet" {
  count             = length(var.availability_zones)
  vpc_id            = aws_vpc.elk_vpc.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone = var.availability_zones[count.index]

  tags = {
    Name        = "${var.project_name}-elk-private-${count.index + 1}"
    Environment = var.environment
    Type        = "private"
  }
}

# Internet Gateway
resource "aws_internet_gateway" "elk_igw" {
  vpc_id = aws_vpc.elk_vpc.id

  tags = {
    Name        = "${var.project_name}-elk-igw"
    Environment = var.environment
  }
}

# Elastic IP for NAT Gateway
resource "aws_eip" "nat_eip" {
  domain     = "vpc"
  depends_on = [aws_internet_gateway.elk_igw]

  tags = {
    Name        = "${var.project_name}-nat-eip"
    Environment = var.environment
  }
}

# NAT Gateway
resource "aws_nat_gateway" "elk_nat" {
  allocation_id = aws_eip.nat_eip.id
  subnet_id     = aws_subnet.elk_private_subnet[0].id

  tags = {
    Name        = "${var.project_name}-nat-gateway"
    Environment = var.environment
  }
}

# Route table for private subnets
resource "aws_route_table" "elk_private_rt" {
  vpc_id = aws_vpc.elk_vpc.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.elk_nat.id
  }

  tags = {
    Name        = "${var.project_name}-private-rt"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "private_subnet_association" {
  count          = length(aws_subnet.elk_private_subnet)
  subnet_id      = aws_subnet.elk_private_subnet[count.index].id
  route_table_id = aws_route_table.elk_private_rt.id
}

# Security group for Elasticsearch
resource "aws_security_group" "elasticsearch_sg" {
  name        = "${var.project_name}-elasticsearch-sg"
  description = "Security group for Elasticsearch cluster"
  vpc_id      = aws_vpc.elk_vpc.id

  # Elasticsearch REST API
  ingress {
    from_port   = 9200
    to_port     = 9200
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "Elasticsearch REST API"
  }

  # Elasticsearch node communication
  ingress {
    from_port   = 9300
    to_port     = 9300
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "Elasticsearch cluster communication"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-elasticsearch-sg"
    Environment = var.environment
  }
}

# Security group for Logstash
resource "aws_security_group" "logstash_sg" {
  name        = "${var.project_name}-logstash-sg"
  description = "Security group for Logstash"
  vpc_id      = aws_vpc.elk_vpc.id

  # Logstash input from application containers
  ingress {
    from_port   = 5044
    to_port     = 5044
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "Logstash Beats input"
  }

  # Logstash HTTP input
  ingress {
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
    description = "Logstash HTTP input"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-logstash-sg"
    Environment = var.environment
  }
}

# Security group for Kibana
resource "aws_security_group" "kibana_sg" {
  name        = "${var.project_name}-kibana-sg"
  description = "Security group for Kibana"
  vpc_id      = aws_vpc.elk_vpc.id

  # Kibana UI
  ingress {
    from_port   = 5601
    to_port     = 5601
    protocol    = "tcp"
    cidr_blocks = var.allowed_kibana_cidr
    description = "Kibana web interface"
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-kibana-sg"
    Environment = var.environment
  }
}

# AWS Elasticsearch Domain
resource "aws_elasticsearch_domain" "elk_cluster" {
  domain_name           = "${var.project_name}-logs-${var.environment}"
  elasticsearch_version = var.elasticsearch_version

  cluster_config {
    instance_type            = var.elasticsearch_instance_type
    instance_count           = var.elasticsearch_instance_count
    dedicated_master_enabled = var.enable_dedicated_master
    dedicated_master_type    = var.dedicated_master_type
    dedicated_master_count   = var.dedicated_master_count
    zone_awareness_enabled   = length(var.availability_zones) > 1

    dynamic "zone_awareness_config" {
      for_each = length(var.availability_zones) > 1 ? [1] : []
      content {
        availability_zone_count = length(var.availability_zones)
      }
    }
  }

  ebs_options {
    ebs_enabled = true
    volume_type = "gp3"
    volume_size = var.elasticsearch_volume_size
    iops        = 3000
    throughput  = 125
  }

  vpc_options {
    subnet_ids         = slice(aws_subnet.elk_private_subnet[*].id, 0, min(length(aws_subnet.elk_private_subnet), var.elasticsearch_instance_count))
    security_group_ids = [aws_security_group.elasticsearch_sg.id]
  }

  advanced_options = {
    "rest.action.multi.allow_explicit_index" = "true"
    "indices.query.bool.max_clause_count"    = "1024"
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https       = true
    tls_security_policy = "Policy-Min-TLS-1-2-2019-07"
  }

  snapshot_options {
    automated_snapshot_start_hour = 2
  }

  access_policies = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          AWS = "*"
        }
        Action   = "es:*"
        Resource = "arn:aws:es:${var.aws_region}:*:domain/${var.project_name}-logs-${var.environment}/*"
        Condition = {
          IpAddress = {
            "aws:SourceIp" = var.vpc_cidr
          }
        }
      }
    ]
  })

  tags = {
    Name        = "${var.project_name}-elasticsearch"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# CloudWatch Log Group for Logstash
resource "aws_cloudwatch_log_group" "logstash_logs" {
  name              = "/aws/ecs/${var.project_name}-logstash-${var.environment}"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "${var.project_name}-logstash-logs"
    Environment = var.environment
  }
}

# IAM role for Logstash
resource "aws_iam_role" "logstash_role" {
  name = "${var.project_name}-logstash-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.project_name}-logstash-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "logstash_execution" {
  role       = aws_iam_role.logstash_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# S3 Bucket for Log Archival (Cold Storage)
resource "aws_s3_bucket" "log_archive" {
  bucket = "${var.project_name}-log-archive-${var.environment}-${data.aws_caller_identity.current.account_id}"

  tags = {
    Name        = "${var.project_name}-log-archive"
    Environment = var.environment
    Purpose     = "Cold storage for archived logs"
  }
}

# Enable versioning for audit and compliance
resource "aws_s3_bucket_versioning" "log_archive_versioning" {
  bucket = aws_s3_bucket.log_archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Enable encryption for archived logs
resource "aws_s3_bucket_server_side_encryption_configuration" "log_archive_encryption" {
  bucket = aws_s3_bucket.log_archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Lifecycle policy to transition to Glacier after 30 days
resource "aws_s3_bucket_lifecycle_configuration" "log_archive_lifecycle" {
  bucket = aws_s3_bucket.log_archive.id

  rule {
    id     = "archive-to-glacier"
    status = "Enabled"

    # Transition to Glacier after configured days for cost optimization
    transition {
      days          = var.log_cold_storage_days
      storage_class = "GLACIER"
    }

    # Deep Archive after configured days for long-term compliance retention
    transition {
      days          = var.log_deep_archive_days
      storage_class = "DEEP_ARCHIVE"
    }

    # Expire objects after configured years (compliance requirement)
    expiration {
      days = var.log_retention_years * 365
    }
  }
}

# Block public access to archive bucket
resource "aws_s3_bucket_public_access_block" "log_archive_pab" {
  bucket = aws_s3_bucket.log_archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# IAM role for Elasticsearch to write snapshots to S3
resource "aws_iam_role" "elasticsearch_snapshot_role" {
  name = "${var.project_name}-es-snapshot-role-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "es.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name        = "${var.project_name}-es-snapshot-role"
    Environment = var.environment
  }
}

# IAM policy for Elasticsearch snapshot access to S3
resource "aws_iam_role_policy" "elasticsearch_snapshot_policy" {
  name   = "${var.project_name}-es-snapshot-policy"
  role   = aws_iam_role.elasticsearch_snapshot_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:ListBucket",
          "s3:GetBucketVersioning",
          "s3:GetBucketLocation",
          "s3:ListBucketVersions"
        ]
        Resource = aws_s3_bucket.log_archive.arn
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObjectVersion"
        ]
        Resource = "${aws_s3_bucket.log_archive.arn}/*"
      }
    ]
  })
}

# Data source to get current AWS account ID
data "aws_caller_identity" "current" {}

output "elasticsearch_endpoint" {
  value       = aws_elasticsearch_domain.elk_cluster.endpoint
  description = "Elasticsearch cluster endpoint"
}

output "elasticsearch_arn" {
  value       = aws_elasticsearch_domain.elk_cluster.arn
  description = "Elasticsearch cluster ARN"
}

output "kibana_endpoint" {
  value       = aws_elasticsearch_domain.elk_cluster.kibana_endpoint
  description = "Kibana endpoint URL"
}

output "vpc_id" {
  value       = aws_vpc.elk_vpc.id
  description = "VPC ID for ELK stack"
}

output "private_subnet_ids" {
  value       = aws_subnet.elk_private_subnet[*].id
  description = "Private subnet IDs"
}

output "log_archive_bucket_name" {
  value       = aws_s3_bucket.log_archive.id
  description = "S3 bucket name for log archival"
}

output "log_archive_bucket_arn" {
  value       = aws_s3_bucket.log_archive.arn
  description = "S3 bucket ARN for log archival"
}

output "elasticsearch_snapshot_role_arn" {
  value       = aws_iam_role.elasticsearch_snapshot_role.arn
  description = "ARN of Elasticsearch snapshot IAM role"
}
