/** Concurrent admin bulk-review load test.
 *
 * BULK_APPROVAL_APPLICATION_IDS must contain IDs from the staging seed. Every
 * response is validated so a fast 200 with missing or duplicated decisions is
 * treated as a failed run.
 */
import { loadConfig } from "../config.js";

const ids = (process.env.BULK_APPROVAL_APPLICATION_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
if (ids.length === 0) throw new Error("BULK_APPROVAL_APPLICATION_IDS is required for the bulk approval load test");

const config = loadConfig();
const token = process.env.ADMIN_JWT ?? process.env.ADMIN_API_KEY;
const body = JSON.stringify({ reviews: ids.map((applicationId) => ({ applicationId, decision: "approve", reason: "staging load test" })) });
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const end = Date.now() + config.duration * 1000;
const latencies: number[] = [];
let requests = 0;
let failures = 0;

function validate(payload: any): boolean {
  const items = [...(payload?.results ?? []), ...(payload?.failures ?? [])];
  const returned = items.map((item: any) => item.applicationId ?? item.id);
  return items.length === ids.length && new Set(returned).size === ids.length && ids.every((id) => returned.includes(id));
}

async function runOne(): Promise<void> {
  const started = performance.now();
  try {
    const response = await fetch(`${config.baseUrl}/api/admin/loans/bulk-review`, { method: "POST", headers, body });
    const payload = await response.json().catch(() => null);
    requests++;
    latencies.push(performance.now() - started);
    if (!response.ok || !validate(payload)) failures++;
  } catch {
    requests++;
    failures++;
  }
}

while (Date.now() < end) {
  await Promise.all(Array.from({ length: config.connections }, () => runOne()));
}

latencies.sort((a, b) => a - b);
const percentile = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0;
const p95 = percentile(0.95);
const errorRate = requests ? failures / requests : 1;
console.log(JSON.stringify({ scenario: "bulk-admin-approval", requests, failures, errorRate, p95Ms: p95, thresholdMs: config.p99ThresholdMs }, null, 2));
if (errorRate > config.maxErrorRate || p95 > config.p99ThresholdMs) process.exit(1);
