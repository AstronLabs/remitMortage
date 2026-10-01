# DevOps Infrastructure

This directory contains the Terraform configuration for deploying the RemitMortgage backend infrastructure.

## Architecture

The infrastructure consists of:
- **VPC**: An isolated virtual private cloud with public and private subnets.
- **RDS PostgreSQL**: A managed relational database instance deployed in the private subnets.
- **ElastiCache Redis**: A managed in-memory cache deployed in the private subnets.
- **App Runner**: A fully managed container application service that runs the backend API, configured with a VPC Connector to access the database and cache securely.
- **Security Groups**: Granular network access controls ensuring the database and cache are only accessible from the App Runner service.

## Prerequisites

- [Terraform](https://www.terraform.io/downloads) (>= 1.5.0)
- [AWS CLI](https://aws.amazon.com/cli/) installed and configured with appropriate credentials
- Docker image pushed to ECR Public (for App Runner)

## Deployment Sequences

### 1. Initialize Terraform

Initialize the working directory containing Terraform configuration files. This is the first command that should be run after writing a new Terraform configuration or cloning an existing one.

```bash
terraform init
```

### 2. Validate Configuration

Validate the configuration files in a directory, referring only to the configuration and not accessing any remote services such as remote state, provider APIs, etc.

```bash
terraform validate
```

### 3. Plan Infrastructure

Create an execution plan, which lets you preview the changes that Terraform plans to make to your infrastructure.

```bash
terraform plan -var="db_password=YOUR_SECURE_PASSWORD"
```

### 4. Apply Infrastructure

Execute the actions proposed in a Terraform plan.

```bash
terraform apply -var="db_password=YOUR_SECURE_PASSWORD"
```

### 5. Destroy Infrastructure

Destroy all remote objects managed by a particular Terraform configuration.

```bash
terraform destroy -var="db_password=YOUR_SECURE_PASSWORD"
```

## Variables

| Variable | Description | Default |
| -------- | ----------- | ------- |
| `aws_region` | AWS region for deployment | `us-east-1` |
| `vpc_cidr` | CIDR block for the VPC | `10.0.0.0/16` |
| `db_username` | Username for the PostgreSQL database | `postgres` |
| `db_password` | Password for the PostgreSQL database | (Required) |
| `app_image` | ECR Image URI for the App Runner service | `public.ecr.aws/nginx/nginx:latest` |
| `environment` | Deployment environment | `dev` |

## Blue-Green Deployment

New backend releases use a blue-green strategy to achieve zero-downtime deploys.

### How It Works

Two App Runner services run in parallel at all times:

| Slot  | Role   | Description                                      |
|-------|--------|--------------------------------------------------|
| Blue  | Active | Currently serving production traffic             |
| Green | Idle   | Staging target for the next release              |

An SSM Parameter Store key (`/remitmortgage/<env>/active-slot`) tracks which slot is live. The deploy workflow reads this to determine which slot is idle, then:

1. Deploys the new image to the idle slot.
2. Waits for the App Runner service to reach `RUNNING`.
3. Runs repeated HTTP health checks against the idle slot's `/api/health` endpoint.
4. Switches traffic by updating the active-slot pointer (and in production, Route 53 weighted records).
5. Soaks for 60 seconds, then runs the **post-deploy health gate**: watches the now-active slot's `/api/health` and 5xx rate for a 5-minute window.
6. **Auto-rollback**: if the gate fails, the active-slot pointer is automatically reverted to the previous known-good slot, and both the failure and the rollback are alerted with diagnostic context. See [docs/AUTOMATIC_ROLLBACK.md](../docs/AUTOMATIC_ROLLBACK.md).

### Trigger a Deployment

Go to **Actions → Blue-Green Deployment → Run workflow** and supply:
- `environment` — `dev`, `staging`, or `production`
- `image_tag` — the Docker image tag to deploy
- `disable_auto_rollback` *(optional)* — alert on a failed health gate but do **not** roll back, for an intentional deploy expected to trip a health signal (e.g. a migration). Requires `override_reason`.

### Required Secrets

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM key with App Runner + SSM + Route 53 write access |
| `AWS_SECRET_ACCESS_KEY` | Corresponding secret key |
| `DEVOPS_ALERT_WEBHOOK_URL` | *(optional)* Slack/Discord webhook for health-gate failure and rollback alerts |
| `METRICS_TOKEN` | *(optional)* Bearer token for `/metrics`, enabling the 5xx-rate signal; without it the gate uses the health signal only |

### Terraform Resources

`blue-green.tf` provisions:
- `aws_apprunner_service.app_blue` — the active slot service
- `aws_apprunner_service.app_green` — the idle slot service
- Outputs: `blue_service_url`, `green_service_url`, `blue_service_arn`, `green_service_arn`

On first deploy, run `terraform apply` to create both services, then trigger the workflow.

---

## Canary Deployment Strategy (#457)

In Kubernetes environment (`devops/k8s/`), backend releases use Nginx Ingress traffic splitting and automated health monitoring:

- **Ramp-Up Stages**: 5% → 25% → 100%
- **Automation Script**: `./scripts/canary-ramp.sh` or `./devops/canary-ramp.sh`
- **Auto-Rollback**: Triggered on `/health` probe failures, 5xx error rate > 1%, or latency degradation. Canaries revert `canary-weight` to `0` and scale canary replicas to `0`.

For detailed manifest configuration and policies, see [devops/k8s/README.md](./k8s/README.md).

---

## Backup Verification

A backup nobody has restored is an assumption, not a recovery plan. The
`Backup Verification` workflow (`.github/workflows/backup-verification.yml`)
runs a full drill on the 1st of every month, and on demand via
`workflow_dispatch`:

1. Stands up a disposable Postgres 16 and applies the live Prisma schema to a
   mock source database.
2. Dumps it with `pg_dump -F c` — the same format
   `backend/src/services/databaseBackup.ts` writes.
3. Restores the dump into a separate sandbox database with `pg_restore`.
4. Compares table names, index names and exact row counts between source and
   restored, failing on any drift.

The drill logic lives in `scripts/verify-backup-restore.sh` and can be pointed
at any pair of databases locally:

```bash
SOURCE_DATABASE_URL=postgres://... \
SANDBOX_DATABASE_URL=postgres://... \
  ./scripts/verify-backup-restore.sh
```

> The sandbox database's `public` schema is dropped and recreated. Never point
> `SANDBOX_DATABASE_URL` at anything you care about.

Every run uploads a `backup-verification-report` artifact (90-day retention)
recording archive size, object counts and the pass/fail verdict — that artifact
is the audit record that recovery was verified for the month.

### Alerting Secrets

Failed scheduled runs email the on-call address. Configure these repository
secrets, or the alert step is skipped:

| Secret | Description |
| ------ | ----------- |
| `ALERT_SMTP_SERVER` | SMTP host used to send failure alerts |
| `ALERT_SMTP_PORT` | SMTP port (e.g. `465` for SMTPS) |
| `ALERT_SMTP_USERNAME` | SMTP account username |
| `ALERT_SMTP_PASSWORD` | SMTP account password or app token |
| `ALERT_EMAIL_TO` | Comma-separated recipients for recovery failures |
