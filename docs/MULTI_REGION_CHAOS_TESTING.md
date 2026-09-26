# Multi-Region Failover Chaos Test

The scheduled workflow runs only against the staging environment. It calls the staging primary control endpoint to block the health-check path, polls the failover hostname, records `failover-result.json`, and restores the primary endpoint in a shell trap.

Required staging secrets are `FAILOVER_PRIMARY_CONTROL_URL`, `FAILOVER_HOST`, and `FAILOVER_EXPECTED_MARKER`. The control endpoint must be authenticated and restricted to the staging network; it must expose `POST /block-health-check` and `POST /restore`.

Run manually from the GitHub Actions workflow dispatch page after confirming both regions are healthy. Never point the workflow at production. The check fails when measured recovery exceeds the documented two-minute RTO. The JSON artifact records start time, recovery time, elapsed seconds, and the target for reproducibility.

To review or intentionally change the target, update `RTO_TARGET_SECONDS` in `.github/workflows/multi-region-chaos.yml` and the performance target in `devops/MULTI_REGION_FAILOVER_GUIDE.md` in the same reviewed change.
