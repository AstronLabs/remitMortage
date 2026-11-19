terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.100.0"
    }
  }

  backend "s3" {
    bucket         = "remit-mortgage-terraform-state"
    key            = "infrastructure/apm/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "remit-mortgage-terraform-locks"
    encrypt        = true
  }
}

# Standard cost-allocation tags, applied to every taggable resource through
# the provider so individual resources cannot forget them. Enforced in CI by
# devops/policy/tags (see docs/COST_ALLOCATION_TAG_POLICY.md).
locals {
  required_tags = {
    Service     = "observability-apm"
    Environment = var.environment
    Owner       = var.owner
    CostCenter  = var.cost_center
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.required_tags
  }
}

# ------------------------------------------------------------------------------
# Networking
# ------------------------------------------------------------------------------
# Standalone VPC, mirroring infrastructure/terraform/elk's pattern: this module
# manages its own network rather than reaching into devops/main.tf's state, so
# the two stacks stay independently deployable. Wire them together at the
# network layer (VPC peering, or simply reachable public endpoints restricted
# by `var.app_source_cidrs`) rather than via Terraform remote-state coupling.
resource "aws_vpc" "apm" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "${var.project_name}-apm-vpc"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_internet_gateway" "apm" {
  vpc_id = aws_vpc.apm.id

  tags = {
    Name        = "${var.project_name}-apm-igw"
    Environment = var.environment
  }
}

resource "aws_subnet" "apm_public" {
  count                   = length(var.availability_zones)
  vpc_id                  = aws_vpc.apm.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name        = "${var.project_name}-apm-public-${count.index + 1}"
    Environment = var.environment
  }
}

resource "aws_route_table" "apm_public" {
  vpc_id = aws_vpc.apm.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.apm.id
  }

  tags = {
    Name        = "${var.project_name}-apm-public-rt"
    Environment = var.environment
  }
}

resource "aws_route_table_association" "apm_public" {
  count          = length(aws_subnet.apm_public)
  subnet_id      = aws_subnet.apm_public[count.index].id
  route_table_id = aws_route_table.apm_public.id
}

# ------------------------------------------------------------------------------
# Security groups
# ------------------------------------------------------------------------------
resource "aws_security_group" "collector" {
  name        = "${var.project_name}-apm-collector-sg"
  description = "Jaeger/OTLP trace collector — accepts OTLP from the backend and UI traffic from the ALB"
  vpc_id      = aws_vpc.apm.id

  ingress {
    description = "OTLP/gRPC trace export from the backend"
    from_port   = var.otlp_grpc_port
    to_port     = var.otlp_grpc_port
    protocol    = "tcp"
    cidr_blocks = var.app_source_cidrs
  }

  ingress {
    description = "OTLP/HTTP trace export from the backend"
    from_port   = var.otlp_http_port
    to_port     = var.otlp_http_port
    protocol    = "tcp"
    cidr_blocks = var.app_source_cidrs
  }

  ingress {
    description     = "Jaeger UI, via the ALB only"
    from_port       = var.ui_port
    to_port         = var.ui_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-apm-collector-sg"
    Environment = var.environment
  }
}

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-apm-alb-sg"
  description = "Public ALB fronting the Jaeger query UI"
  vpc_id      = aws_vpc.apm.id

  ingress {
    description = "Jaeger UI"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.allowed_ui_cidrs
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name        = "${var.project_name}-apm-alb-sg"
    Environment = var.environment
  }
}

# ------------------------------------------------------------------------------
# Load balancers
# ------------------------------------------------------------------------------
# ALB for the Jaeger query UI (human access, restricted by allowed_ui_cidrs).
resource "aws_lb" "ui" {
  name               = "${var.project_name}-apm-ui-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.apm_public[*].id

  tags = {
    Name        = "${var.project_name}-apm-ui-alb"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "ui" {
  name        = "${var.project_name}-apm-ui-tg"
  port        = var.ui_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.apm.id
  target_type = "ip"

  health_check {
    path                = "/"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
  }
}

resource "aws_lb_listener" "ui" {
  load_balancer_arn = aws_lb.ui.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ui.arn
  }
}

# NLB for OTLP ingestion — gives the backend's OTEL_EXPORTER_OTLP_ENDPOINT a
# stable DNS name rather than a Fargate task's ephemeral public IP.
resource "aws_lb" "otlp" {
  name               = "${var.project_name}-apm-otlp-nlb"
  internal           = false
  load_balancer_type = "network"
  subnets            = aws_subnet.apm_public[*].id

  tags = {
    Name        = "${var.project_name}-apm-otlp-nlb"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "otlp_grpc" {
  name        = "${var.project_name}-apm-otlp-grpc-tg"
  port        = var.otlp_grpc_port
  protocol    = "TCP"
  vpc_id      = aws_vpc.apm.id
  target_type = "ip"

  health_check {
    protocol = "TCP"
  }
}

resource "aws_lb_target_group" "otlp_http" {
  name        = "${var.project_name}-apm-otlp-http-tg"
  port        = var.otlp_http_port
  protocol    = "TCP"
  vpc_id      = aws_vpc.apm.id
  target_type = "ip"

  health_check {
    protocol = "TCP"
  }
}

resource "aws_lb_listener" "otlp_grpc" {
  load_balancer_arn = aws_lb.otlp.arn
  port              = var.otlp_grpc_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.otlp_grpc.arn
  }
}

resource "aws_lb_listener" "otlp_http" {
  load_balancer_arn = aws_lb.otlp.arn
  port              = var.otlp_http_port
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.otlp_http.arn
  }
}

# ------------------------------------------------------------------------------
# ECS Fargate: Jaeger all-in-one (collector + storage + query UI)
# ------------------------------------------------------------------------------
resource "aws_ecs_cluster" "apm" {
  name = "${var.project_name}-apm-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name        = "${var.project_name}-apm-cluster"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "jaeger" {
  name              = "/ecs/${var.project_name}-apm-jaeger-${var.environment}"
  retention_in_days = var.log_retention_days

  tags = {
    Name        = "${var.project_name}-apm-jaeger-logs"
    Environment = var.environment
  }
}

resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-apm-ecs-execution-${var.environment}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action    = "sts:AssumeRole"
        Effect    = "Allow"
        Principal = { Service = "ecs-tasks.amazonaws.com" }
      }
    ]
  })

  tags = {
    Name        = "${var.project_name}-apm-ecs-execution-role"
    Environment = var.environment
  }
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "jaeger" {
  family                   = "${var.project_name}-apm-jaeger-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.jaeger_cpu
  memory                   = var.jaeger_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name  = "jaeger"
      image = var.jaeger_image
      portMappings = [
        { containerPort = var.ui_port, protocol = "tcp" },
        { containerPort = var.otlp_grpc_port, protocol = "tcp" },
        { containerPort = var.otlp_http_port, protocol = "tcp" },
      ]
      environment = [
        # Native OTLP receiver — lets Jaeger accept traces directly from the
        # backend's OpenTelemetry SDK without a separate collector process.
        { name = "COLLECTOR_OTLP_ENABLED", value = "true" },
        { name = "SPAN_STORAGE_TYPE", value = "memory" },
        { name = "MEMORY_MAX_TRACES", value = "100000" },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.jaeger.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "jaeger"
        }
      }
    }
  ])

  tags = {
    Name        = "${var.project_name}-apm-jaeger-task"
    Environment = var.environment
  }
}

resource "aws_ecs_service" "jaeger" {
  name            = "${var.project_name}-apm-jaeger-${var.environment}"
  cluster         = aws_ecs_cluster.apm.id
  task_definition = aws_ecs_task_definition.jaeger.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.apm_public[*].id
    security_groups  = [aws_security_group.collector.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.ui.arn
    container_name   = "jaeger"
    container_port   = var.ui_port
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.otlp_grpc.arn
    container_name   = "jaeger"
    container_port   = var.otlp_grpc_port
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.otlp_http.arn
    container_name   = "jaeger"
    container_port   = var.otlp_http_port
  }

  depends_on = [aws_lb_listener.ui, aws_lb_listener.otlp_grpc, aws_lb_listener.otlp_http]

  tags = {
    Name        = "${var.project_name}-apm-jaeger-service"
    Environment = var.environment
  }
}

# ------------------------------------------------------------------------------
# Outputs
# ------------------------------------------------------------------------------
output "jaeger_ui_url" {
  value       = "http://${aws_lb.ui.dns_name}"
  description = "Jaeger query UI — trace search and the service dependency graph"
}

output "otlp_grpc_endpoint" {
  value       = "${aws_lb.otlp.dns_name}:${var.otlp_grpc_port}"
  description = "OTLP/gRPC endpoint for the backend's trace exporter"
}

output "otlp_http_endpoint" {
  value       = "http://${aws_lb.otlp.dns_name}:${var.otlp_http_port}"
  description = "Value for the backend's OTEL_EXPORTER_OTLP_ENDPOINT env var"
}

output "collector_security_group_id" {
  value       = aws_security_group.collector.id
  description = "Security group id fronting the collector, in case another module needs to reference it"
}
