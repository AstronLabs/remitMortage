"""Unit tests for scripts/cost_drift_check.py.

Run with: python3 -m unittest discover -s scripts -p "test_cost_drift_check.py"
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cost_drift_check as cdc  # noqa: E402


def infracost(resources):
    return {
        "projects": [
            {
                "name": "devops-root",
                "breakdown": {
                    "resources": [
                        {"name": f"{t}.x{i}", "resourceType": t, "monthlyCost": c}
                        for i, (t, c) in enumerate(resources)
                    ]
                },
            }
        ]
    }


def cost_explorer(amounts, periods=1):
    return {
        "ResultsByTime": [
            {
                "Groups": [
                    {"Keys": [service], "Metrics": {"UnblendedCost": {"Amount": str(amount / periods), "Unit": "USD"}}}
                    for service, amount in amounts.items()
                ]
            }
            for _ in range(periods)
        ]
    }


class ServiceMappingTest(unittest.TestCase):
    def test_longest_prefix_wins_and_unbilled_types_are_unmapped(self):
        self.assertEqual(cdc.service_for_resource_type("aws_db_instance"), "Amazon Relational Database Service")
        self.assertEqual(cdc.service_for_resource_type("aws_lb_listener"), "Amazon Elastic Load Balancing")
        self.assertEqual(cdc.service_for_resource_type("aws_nat_gateway"), "EC2 - Other")
        self.assertIsNone(cdc.service_for_resource_type("aws_security_group"))


class AggregationTest(unittest.TestCase):
    def test_estimates_sum_per_service_and_surface_unmapped_costs(self):
        estimates, unmapped = cdc.estimates_by_service(
            infracost(
                [
                    ("aws_db_instance", "100"),
                    ("aws_rds_cluster", "20.5"),
                    ("aws_apprunner_service", "40"),
                    ("aws_security_group", None),
                    ("aws_mystery_thing", "7"),
                ]
            )
        )
        self.assertEqual(estimates["Amazon Relational Database Service"], 120.5)
        self.assertEqual(estimates["AWS App Runner"], 40)
        self.assertEqual(unmapped, {"aws_mystery_thing": 7.0})

    def test_actuals_sum_across_periods(self):
        actuals = cdc.actuals_by_service(cost_explorer({"AWS App Runner": 90}, periods=3))
        self.assertAlmostEqual(actuals["AWS App Runner"], 90)


class CompareTest(unittest.TestCase):
    def test_service_beyond_threshold_is_flagged(self):
        rows = cdc.compare({"AWS App Runner": 100}, {"AWS App Runner": 130}, threshold_pct=25, min_delta_usd=10)
        self.assertEqual(rows[0].status, "DRIFT")
        self.assertAlmostEqual(rows[0].delta_pct, 30)

    def test_services_within_normal_variance_are_not_flagged(self):
        rows = cdc.compare(
            {"AWS App Runner": 100, "Amazon ElastiCache": 50},
            {"AWS App Runner": 124, "Amazon ElastiCache": 20},
            threshold_pct=25,
            min_delta_usd=10,
        )
        self.assertEqual({r.status for r in rows}, {"OK"})

    def test_small_dollar_overruns_do_not_alert(self):
        rows = cdc.compare({"Amazon Route 53": 1.0}, {"Amazon Route 53": 4.0}, threshold_pct=25, min_delta_usd=10)
        self.assertEqual(rows[0].status, "OK")

    def test_spend_without_an_estimate_is_reported_but_not_drift(self):
        rows = cdc.compare({}, {"AWS Data Transfer": 500}, threshold_pct=25, min_delta_usd=10)
        self.assertEqual(rows[0].status, "UNESTIMATED")
        self.assertIsNone(rows[0].delta_pct)


class CliTest(unittest.TestCase):
    def run_cli(self, baseline, actuals, *extra):
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path = os.path.join(tmp, "baseline.json")
            actuals_path = os.path.join(tmp, "actuals.json")
            report_path = os.path.join(tmp, "report.md")
            with open(baseline_path, "w") as f:
                json.dump(baseline, f)
            with open(actuals_path, "w") as f:
                json.dump(actuals, f)
            with open(os.devnull, "w") as devnull:
                stdout, sys.stdout = sys.stdout, devnull
                try:
                    code = cdc.main(
                        ["--baseline", baseline_path, "--actuals", actuals_path, "--report", report_path, *extra]
                    )
                finally:
                    sys.stdout = stdout
            with open(report_path) as f:
                return code, f.read()

    def test_exit_code_2_and_report_when_a_service_drifts(self):
        code, report = self.run_cli(
            infracost([("aws_apprunner_service", "100"), ("aws_db_instance", "200")]),
            cost_explorer({"AWS App Runner": 400, "Amazon Relational Database Service": 205}),
            "--threshold-pct",
            "20",
            "--period",
            "2026-08",
        )
        self.assertEqual(code, 2)
        self.assertIn("1 service(s) drifted", report)
        self.assertIn("| AWS App Runner | 100.00 | 400.00 | +300.00 (+300.0%) | **DRIFT** |", report)
        self.assertIn("2026-08", report)

    def test_exit_code_0_when_all_services_are_within_variance(self):
        code, report = self.run_cli(
            infracost([("aws_apprunner_service", "100")]),
            cost_explorer({"AWS App Runner": 105, "AWS Data Transfer": 30}),
        )
        self.assertEqual(code, 0)
        self.assertIn("No service drifted", report)

    def test_threshold_is_configurable(self):
        baseline = infracost([("aws_apprunner_service", "100")])
        actuals = cost_explorer({"AWS App Runner": 140})
        self.assertEqual(self.run_cli(baseline, actuals, "--threshold-pct", "50")[0], 0)
        self.assertEqual(self.run_cli(baseline, actuals, "--threshold-pct", "30")[0], 2)

    def test_unreadable_input_exits_1(self):
        with open(os.devnull, "w") as devnull:
            stderr, sys.stderr = sys.stderr, devnull
            try:
                code = cdc.main(["--baseline", "/nonexistent.json", "--actuals", "/nonexistent.json"])
            finally:
                sys.stderr = stderr
        self.assertEqual(code, 1)


if __name__ == "__main__":
    unittest.main()
