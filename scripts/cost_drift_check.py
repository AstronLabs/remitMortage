#!/usr/bin/env python3
"""Compare actual AWS spend per service against the Infracost baseline.

Infracost estimates the monthly cost of the Terraform config when it is
deployed; AWS Cost Explorer reports what that infrastructure actually cost.
This script lines the two up per AWS service and flags services whose actual
spend exceeds the estimate by more than a configurable percentage (e.g. an
autoscaling misconfiguration running far more instances than planned).

Inputs:
  --baseline  JSON from `infracost breakdown --format=json` recorded at deploy
  --actuals   JSON from `aws ce get-cost-and-usage --group-by
              Type=DIMENSION,Key=SERVICE` for the month being checked

Exit codes (mirroring `terraform plan -detailed-exitcode`):
  0  no service drifted beyond the threshold
  1  error reading or parsing inputs
  2  one or more services drifted beyond the threshold

See docs/TERRAFORM_COST_DRIFT_DETECTION.md.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass

# Terraform resource-type prefix -> AWS Cost Explorer SERVICE dimension value.
# Longest matching prefix wins, so specific entries (aws_lb_) coexist with
# broader ones. Resource types with no billing of their own (security groups,
# subnets, IAM, policies) are intentionally absent.
SERVICE_BY_RESOURCE_PREFIX = {
    "aws_apprunner_": "AWS App Runner",
    "aws_cloudfront_": "Amazon CloudFront",
    "aws_cloudwatch_": "AmazonCloudWatch",
    "aws_db_": "Amazon Relational Database Service",
    "aws_rds_": "Amazon Relational Database Service",
    "aws_dynamodb_": "Amazon DynamoDB",
    "aws_ebs_": "EC2 - Other",
    "aws_ecr_": "Amazon EC2 Container Registry (ECR)",
    "aws_ecs_": "Amazon Elastic Container Service",
    "aws_eip": "EC2 - Other",
    "aws_eks_": "Amazon Elastic Container Service for Kubernetes",
    "aws_elasticache_": "Amazon ElastiCache",
    "aws_elasticsearch_": "Amazon OpenSearch Service",
    "aws_opensearch_": "Amazon OpenSearch Service",
    "aws_instance": "Amazon Elastic Compute Cloud - Compute",
    "aws_kms_": "AWS Key Management Service",
    "aws_lambda_": "AWS Lambda",
    "aws_lb": "Amazon Elastic Load Balancing",
    "aws_alb": "Amazon Elastic Load Balancing",
    "aws_nat_gateway": "EC2 - Other",
    "aws_route53_": "Amazon Route 53",
    "aws_s3_": "Amazon Simple Storage Service",
    "aws_secretsmanager_": "AWS Secrets Manager",
    "aws_sns_": "Amazon Simple Notification Service",
    "aws_sqs_": "Amazon Simple Queue Service",
}


@dataclass
class ServiceComparison:
    service: str
    estimated: float
    actual: float
    status: str  # DRIFT | OK | UNESTIMATED

    @property
    def delta(self) -> float:
        return self.actual - self.estimated

    @property
    def delta_pct(self) -> float | None:
        if self.estimated <= 0:
            return None
        return self.delta / self.estimated * 100


def service_for_resource_type(resource_type: str) -> str | None:
    matches = [p for p in SERVICE_BY_RESOURCE_PREFIX if resource_type.startswith(p)]
    if not matches:
        return None
    return SERVICE_BY_RESOURCE_PREFIX[max(matches, key=len)]


def _to_float(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def estimates_by_service(breakdown: dict) -> tuple[dict[str, float], dict[str, float]]:
    """Sum Infracost monthly costs per AWS service.

    Returns (estimates, unmapped) where `unmapped` holds the monthly cost of
    resource types with no service mapping, so they can be surfaced instead of
    silently dropped.
    """
    estimates: dict[str, float] = {}
    unmapped: dict[str, float] = {}
    for project in breakdown.get("projects") or []:
        resources = ((project.get("breakdown") or {}).get("resources")) or []
        for resource in resources:
            resource_type = resource.get("resourceType") or ""
            cost = _to_float(resource.get("monthlyCost"))
            service = service_for_resource_type(resource_type)
            if service is None:
                if cost > 0:
                    unmapped[resource_type] = unmapped.get(resource_type, 0.0) + cost
                continue
            estimates[service] = estimates.get(service, 0.0) + cost
    return estimates, unmapped


def actuals_by_service(cost_and_usage: dict, metric: str = "UnblendedCost") -> dict[str, float]:
    """Sum Cost Explorer spend per SERVICE group across all returned periods."""
    actuals: dict[str, float] = {}
    for period in cost_and_usage.get("ResultsByTime") or []:
        for group in period.get("Groups") or []:
            keys = group.get("Keys") or []
            if not keys:
                continue
            amount = _to_float(((group.get("Metrics") or {}).get(metric) or {}).get("Amount"))
            actuals[keys[0]] = actuals.get(keys[0], 0.0) + amount
    return actuals


def compare(
    estimates: dict[str, float],
    actuals: dict[str, float],
    threshold_pct: float,
    min_delta_usd: float,
) -> list[ServiceComparison]:
    """Classify every service seen in either input.

    A service is DRIFT when it has a positive estimate and its actual spend
    exceeds the estimate by more than `threshold_pct` percent AND by at least
    `min_delta_usd` dollars. The dollar floor keeps a $0.40 service billing
    $1.10 from paging anyone. Services with spend but no estimate are
    UNESTIMATED: Infracost cannot price most usage-based charges (data
    transfer, requests), so those are reported but never alerted on.
    """
    rows = []
    for service in sorted(set(estimates) | set(actuals)):
        estimated = estimates.get(service, 0.0)
        actual = actuals.get(service, 0.0)
        if estimated <= 0:
            status = "UNESTIMATED"
        elif actual > estimated * (1 + threshold_pct / 100) and actual - estimated >= min_delta_usd:
            status = "DRIFT"
        else:
            status = "OK"
        rows.append(ServiceComparison(service, estimated, actual, status))
    return rows


def render_markdown(
    rows: list[ServiceComparison],
    unmapped: dict[str, float],
    threshold_pct: float,
    min_delta_usd: float,
    period: str | None = None,
) -> str:
    drifted = [r for r in rows if r.status == "DRIFT"]
    lines = ["## Terraform Cost Drift Report", ""]
    if period:
        lines.append(f"**Billing period:** {period}  ")
    lines.append(
        f"**Threshold:** actual > estimate by more than {threshold_pct:g}% and at least ${min_delta_usd:,.2f}"
    )
    lines.append("")
    if drifted:
        lines.append(f"**{len(drifted)} service(s) drifted beyond the threshold.**")
    else:
        lines.append("No service drifted beyond the threshold.")
    lines += [
        "",
        "| Service | Estimated (USD) | Actual (USD) | Delta | Status |",
        "|---|---:|---:|---:|---|",
    ]
    order = {"DRIFT": 0, "OK": 1, "UNESTIMATED": 2}
    for row in sorted(rows, key=lambda r: (order[r.status], -r.delta)):
        pct = f" ({row.delta_pct:+.1f}%)" if row.delta_pct is not None else ""
        marker = "**DRIFT**" if row.status == "DRIFT" else row.status
        lines.append(
            f"| {row.service} | {row.estimated:,.2f} | {row.actual:,.2f} | {row.delta:+,.2f}{pct} | {marker} |"
        )
    if unmapped:
        lines += [
            "",
            "Resource types with an estimate but no service mapping "
            "(add them to `SERVICE_BY_RESOURCE_PREFIX` in `scripts/cost_drift_check.py`):",
            "",
        ]
        for resource_type, cost in sorted(unmapped.items()):
            lines.append(f"- `{resource_type}`: ${cost:,.2f}/month")
    return "\n".join(lines) + "\n"


def _load_json(path: str) -> dict:
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--baseline", required=True, help="Infracost breakdown JSON recorded at deploy")
    parser.add_argument("--actuals", required=True, help="Cost Explorer get-cost-and-usage JSON grouped by SERVICE")
    parser.add_argument(
        "--threshold-pct",
        type=float,
        default=float(os.environ.get("COST_DRIFT_THRESHOLD_PCT", "25")),
        help="Alert when actual exceeds estimate by more than this percent (default 25, env COST_DRIFT_THRESHOLD_PCT)",
    )
    parser.add_argument(
        "--min-delta-usd",
        type=float,
        default=float(os.environ.get("COST_DRIFT_MIN_DELTA_USD", "10")),
        help="Ignore overruns smaller than this many dollars (default 10, env COST_DRIFT_MIN_DELTA_USD)",
    )
    parser.add_argument("--metric", default="UnblendedCost", help="Cost Explorer metric to read (default UnblendedCost)")
    parser.add_argument("--period", help="Billing period label for the report, e.g. 2026-08")
    parser.add_argument("--report", help="Write the Markdown report to this path as well as stdout")
    args = parser.parse_args(argv)

    if args.threshold_pct < 0 or args.min_delta_usd < 0:
        print("error: --threshold-pct and --min-delta-usd must be non-negative", file=sys.stderr)
        return 1

    try:
        estimates, unmapped = estimates_by_service(_load_json(args.baseline))
        actuals = actuals_by_service(_load_json(args.actuals), args.metric)
    except (OSError, json.JSONDecodeError, AttributeError) as error:
        print(f"error: could not read cost inputs: {error}", file=sys.stderr)
        return 1

    rows = compare(estimates, actuals, args.threshold_pct, args.min_delta_usd)
    report = render_markdown(rows, unmapped, args.threshold_pct, args.min_delta_usd, args.period)
    print(report)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as handle:
            handle.write(report)

    return 2 if any(r.status == "DRIFT" for r in rows) else 0


if __name__ == "__main__":
    sys.exit(main())
