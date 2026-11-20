# HTTP Payload Size Metrics

The API records request and response body sizes on every completed request. Both
histograms use the **matched route template** (`/api/loan/:id`) rather than the
raw URL, so ids never create label values.

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `remitmortgage_http_request_body_size_bytes` | histogram | `method`, `route` | Declared request body size (`Content-Length`) |
| `remitmortgage_http_response_body_size_bytes` | histogram | `method`, `route` | Bytes actually written to the response |
| `remitmortgage_route_latency_budget_exceeded_total` | counter | `method`, `route` | Requests slower than their configured budget (see `config/routeLatencyBudgets.ts`) |

Buckets: 100 B, 1 KB, 10 KB, 100 KB, 1 MB, 10 MB.

## Dashboard query

Average response size and the p95, per route, over the last hour:

```promql
sum by (route) (rate(remitmortgage_http_response_body_size_bytes_sum[1h]))
  /
sum by (route) (rate(remitmortgage_http_response_body_size_bytes_count[1h]))
```

Request bodies larger than 100 KB, by route:

```promql
sum by (route) (
  rate(remitmortgage_http_request_body_size_bytes_count{le="+Inf"}[1h])
  -
  rate(remitmortgage_http_request_body_size_bytes_count{le="100000"}[1h])
)
```

A single `route` value ranking unusually high is either a legitimately large
payload endpoint or a client sending more than the route needs. Cross-check it
with `remitmortgage_payload_rejected_total` (413s) and the latency budget
counter above.
