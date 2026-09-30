# Geo-DNS & CDN Testing Procedures

This document describes how to verify that:

1. **Geo-DNS routing** resolves your domain to the nearest CloudFront edge location based on the requester's geography.
2. **CDN edge caching** serves static Next.js build assets (e.g. `_next/static/*`) from cache with minimal latency.

---

## Prerequisites

- Terraform has been applied and the CloudFront distribution is `Deployed`.
- DNS propagation has settled (wait 5 minutes after `terraform apply` or use `--servers` to bypass local cache).
- `curl`, `dig`, `python3` and `jq` are available on the test machine.

---

## 1. Geo-DNS Verification

### 1.1  Check the DNS resolution from your location

```bash
dig +short A remitmortgage.com
```

Expected output — a CloudFront domain name (alias target):

```
d123.cloudfront.net
```

If you see a raw IP address instead, the alias record is not yet propagated.

### 1.2  Resolve from different geographic regions

Route53 geolocation relies on the IP address of the **resolver**, not the client.  
Use public DNS resolvers in different continents to simulate regional routing.

#### North America (Cloudflare `1.1.1.1`)

```bash
dig @1.1.1.1 +short A remitmortgage.com
```

#### Europe (Google `8.8.8.8`)

```bash
dig @8.8.8.8 +short A remitmortgage.com
```

#### Asia (Quad9 `149.112.112.112` – anycast, but usually lands in JP/APAC)

```bash
dig @149.112.112.112 +short A remitmortgage.com
```

> **Expected**: All responses return the same CloudFront distribution domain,  
> because all continent records currently point to the same CloudFront alias.  
> When per-region origin stacks are added in the future, the `set_identifier`s  
> (`geo-NA`, `geo-EU`, etc.) will route to different targets.

### 1.3  Use geo-located test endpoints (recommended)

For true end-to-end verification, run curl from VMs or serverless functions  
in multiple AWS regions:

```bash
# From us-east-1 (N. Virginia)
curl -sI https://remitmortgage.com | grep -i 'x-cache\|cf-ray\|server'

# From eu-west-1 (Ireland)
curl -sI https://remitmortgage.com | grep -i 'x-cache\|cf-ray\|server'

# From ap-southeast-1 (Singapore)
curl -sI https://remitmortgage.com | grep -i 'x-cache\|cf-ray\|server'
```

**What to look for:**

| Header | Value | Indicates |
|--------|-------|-----------|
| `x-cache` | `Hit from cloudfront` | Served from edge cache |
| `x-cache` | `Miss from cloudfront` | Cache miss (expected on first request) |
| `via` | `1.1 ... (cloudfront)` | Request went through CloudFront |

### 1.4  Programmatic multi-region check

Use AWS Lambda or a script calling https://checkip.amazonaws.com to confirm
the correct origin is hit per location.  Example script:

```bash
#!/usr/bin/env bash
# Requires: curl, dig, python3
REGIONS=("us-east-1" "eu-west-1" "ap-southeast-1" "sa-east-1")
DOMAIN="remitmortgage.com"

for region in "${REGIONS[@]}"; do
  echo "=== $region ==="
  # AWS provides regional Route53 resolver IPs (this simulates geo):
  resolver="ns-$region.route53.amazonaws.com"
  dig @"$resolver" +short A "$DOMAIN"
done
```

---

## 2. CDN Edge Caching Verification

### 2.1  Verify cache headers on static assets

```bash
# Immutable Next.js build asset
curl -sI "https://remitmortgage.com/_next/static/chunks/main-abc123.js" -o /dev/null -w '%header{cache-control}\n%header{x-cache}\n'
```

**Expected output:**

```
public, max-age=31536000, immutable
Hit from cloudfront
```

- `max-age=31536000` → 1-year cache lifetime (matches the `NextJsStaticImmutable` policy).
- `immutable` → tells browsers never to revalidate on reload.
- `Hit from cloudfront` → served from an edge cache (after the first request).

### 2.2  Run a cache hit ratio test

```bash
for i in $(seq 1 10); do
  curl -sI "https://remitmortgage.com/_next/static/chunks/main-abc123.js" \
    | grep -E 'x-cache|x-amz-cf-pop'
done
```

The first request returns `Miss`, all subsequent requests should return `Hit`.  
The `x-amz-cf-pop` header shows which CloudFront edge location served the asset.

### 2.3  Verify API routes are NOT cached

```bash
curl -sI "https://remitmortgage.com/api/health" -o /dev/null -w '%header{cache-control}\n%header{x-cache}\n'
```

**Expected:**

```
no-store, no-cache, must-revalidate
Miss from cloudfront
```

- `no-store` → origin tells CloudFront not to cache.
- Every request to `/api/*` should bypass the edge cache entirely.

### 2.4  Measure time-to-first-byte (TTFB) with and without CDN

**With CDN (CloudFront):**

```bash
curl -w "TCP handshake: %{time_connect}s\nTTFB: %{time_starttransfer}s\nTotal: %{time_total}s\n" \
  -s -o /dev/null "https://remitmortgage.com/_next/static/chunks/main-abc123.js"
```

**Direct to origin (bypass CloudFront for comparison):**

```bash
curl -w "TCP handshake: %{time_connect}s\nTTFB: %{time_starttransfer}s\nTotal: %{time_total}s\n" \
  -s -o /dev/null "https://origin-apprunner-url.aws.com/_next/static/chunks/main-abc123.js"
```

The CDN path should show significantly lower TTFB for cached assets,  
especially when tested from a region distant from the origin server.

---

# 3. Automated Testing with GitHub Actions

The following ad-hoc workflow can be triggered via `workflow_dispatch`  
to validate CDN + Geo-DNS from multiple AWS regions simultaneously:

```yaml
name: CDN / Geo-DNS Smoke Test
on: [workflow_dispatch]
jobs:
  geo-check:
    strategy:
      matrix:
        region: [us-east-1, eu-west-1, ap-southeast-1, sa-east-1]
    runs-on: ubuntu-latest
    steps:
      - name: Check DNS resolution
        run: |
          echo "=== Resolving from ${{ matrix.region }} ==="
          dig @ns-${{ matrix.region }}.route53.amazonaws.com \
            +short A remitmortgage.com

      - name: Check cache status
        run: |
          curl -sI https://remitmortgage.com/_next/static/chunks/main-abc123.js \
            -o /dev/null -w "x-cache: %header{x-cache}\ncf-pop: %header{x-amz-cf-pop}\n"
```

---

## 4. Automated Deployment CDN Cache Invalidation

The deployment pipeline (`.github/workflows/blue-green-deploy.yml`) automatically triggers and verifies CDN cache invalidation after traffic switch and post-deploy health check verification:

- **Script:** `scripts/invalidate-cdn-cache.mjs` (unit tested via `scripts/invalidate-cdn-cache.test.mjs`).
- **Paths invalidated:** `/_next/static/*` and `/public/*` (configurable via `INVALIDATION_PATHS`).
- **Verification:** Polls `aws cloudfront get-invalidation` until status reaches `Completed`.
- **Alerting:** Posts alerts to `DEVOPS_ALERT_WEBHOOK_URL` if invalidation fails or times out.

Manual local run:

```bash
node scripts/invalidate-cdn-cache.mjs
```

---

## 5. Edge Cases & Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `dig` returns an IP, not a CloudFront domain | Route53 alias not yet propagated | Wait 60 s, retry with `+trace` |
| `x-cache: Miss` after many requests | Cache policy TTL too short, or asset not in `_next/static/*` | Verify the path pattern matches; increase `default_ttl` |
| `x-cache: Error from cloudfront` | Origin is unhealthy or CloudFront cannot reach it | Check `frontend_origin_domain`; verify App Runner / ALB is accepting traffic |
| `curl: (60) SSL certificate problem` | Certificate not yet provisioned for the CloudFront domain | Ensure `certificate_arn` covers all `aliases` |
| API responses are cached | Cache policy for `/api/*` not applied | Verify `ordered_cache_behavior` for `/api/*` uses `cache_policy_disabled` |
| CDN Invalidation fails on deploy | Missing IAM permissions or invalid distribution ID | Verify `CLOUDFRONT_DISTRIBUTION_ID` secret and AWS credentials |
| Different continents resolve to different IPs | (Desired in future) | Currently expected — all alias records point to the same CloudFront distribution |

---

## 6. Re-testing After Changes

After any Terraform change that affects DNS or caching:

```bash
# 1. Re-apply Terraform
terraform apply

# 2. Wait for CloudFront deployment (~5-15 min)
aws cloudfront wait distribution-deployed --id <distribution-id>

# 3. Flush CloudFront cache
node scripts/invalidate-cdn-cache.mjs

# 4. Re-run sections 1 and 2 above
```

