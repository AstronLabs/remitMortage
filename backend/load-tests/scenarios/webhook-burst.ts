// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Webhook delivery burst load test (issue #761).
 *
 * Simulates a burst of webhook-triggering events (bulk admin action, batch
 * event replay) and measures delivery latency, queue depth, and retry
 * behaviour under load — the delivery path has never been load tested under
 * burst conditions.
 *
 * How it works:
 *  1. Starts a local subscriber sink (HTTP server) that records arrival
 *     timestamps and answers 200 after SINK_LATENCY_MS (with an optional
 *     SINK_FAIL_RATE of 500s to exercise retries/DLQ).
 *  2. Sweeps burst levels (WEBHOOK_BURST_LEVELS, default "50,200,500"):
 *     enqueues N `deliver-webhook` jobs at once on an isolated BullMQ queue
 *     and serves them with a worker configured like the production
 *     webhook worker (WEBHOOK_BURST_CONCURRENCY, default 20 — the same as
 *     `workers/webhookWorker.ts`; attempts/backoff mirror
 *     `services/queueService.ts` DEFAULT_JOB_OPTIONS).
 *  3. Reports per level: enqueue rate, delivery latency p50/p95/max, max
 *     observed queue depth, retries, DLQ count, and achieved throughput —
 *     and flags the first level where p95 exceeds WEBHOOK_BURST_P95_SLA_MS
 *     (default 2000ms) or the DLQ starts absorbing failures it shouldn't.
 *
 * Requirements: a reachable Redis (REDIS_URL, default
 * redis://localhost:6379). The queue name is unique per run so scheduled CI
 * never collides with production queues.
 *
 * This test is intentionally NOT part of per-PR CI (runtime cost + needs
 * Redis): it runs on the weekly schedule in
 * `.github/workflows/webhook-burst-load.yml` and on demand via
 * `npm run load-test:webhook-burst`.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6379 \
 *   WEBHOOK_BURST_LEVELS="50,200,500" WEBHOOK_BURST_CONCURRENCY=20 \
 *   npx tsx load-tests/scenarios/webhook-burst.ts
 */

import http from "node:http";
import { Queue, Worker, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { promises as fs } from "node:fs";
import path from "node:path";

interface BurstLevelResult {
  burstSize: number;
  concurrency: number;
  wallMs: number;
  enqueuedPerSec: number;
  deliveredPerSec: number;
  latencyMs: { p50: number; p95: number; max: number; mean: number };
  maxQueueDepth: number;
  retries: number;
  dlq: number;
  slaBreached: boolean;
  breachReason: string;
}

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const LEVELS = (process.env.WEBHOOK_BURST_LEVELS ?? "50,200,500")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const CONCURRENCY = num(process.env.WEBHOOK_BURST_CONCURRENCY, 20);
const SINK_LATENCY_MS = num(process.env.SINK_LATENCY_MS, 25);
const SINK_FAIL_RATE = Math.min(1, Math.max(0, Number(process.env.SINK_FAIL_RATE ?? 0)));
const FETCH_TIMEOUT_MS = 10_000;
const P95_SLA_MS = num(process.env.WEBHOOK_BURST_P95_SLA_MS, 2000);
const MAX_ATTEMPTS = 5;
const ENFORCE_SLA = process.env.ENFORCE_SLA === "1";

if (LEVELS.length === 0) throw new Error("WEBHOOK_BURST_LEVELS must list at least one positive burst size");

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

/** Local subscriber sink: records arrivals, answers 200 after a delay. */
async function startSink(): Promise<{ url: string; arrivals: number[]; close: () => Promise<void> }> {
  const arrivals: number[] = [];
  let seen = 0;
  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }
    // Drain the body before responding, like a real subscriber would.
    req.resume();
    req.on("end", () => {
      arrivals.push(Date.now());
      seen += 1;
      const shouldFail = SINK_FAIL_RATE > 0 && seen % Math.max(1, Math.round(1 / SINK_FAIL_RATE)) === 0;
      setTimeout(() => {
        res.statusCode = shouldFail ? 500 : 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: !shouldFail }));
      }, SINK_LATENCY_MS);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("sink failed to bind");
  return {
    url: `http://127.0.0.1:${addr.port}/hooks`,
    arrivals,
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function postWithTimeout(url: string, body: string): Promise<{ ok: boolean; status: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    await res.text().catch(() => "");
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

async function runLevel(
  burstSize: number,
  sinkUrl: string,
  redis: Redis
): Promise<BurstLevelResult> {
  const queueName = `webhook-burst-${Date.now()}-${burstSize}`;
  const queue = new Queue(queueName, { connection: redis });
  const events = new QueueEvents(queueName, { connection: redis.duplicate() });
  await events.waitUntilReady();

  const latencies: number[] = [];
  const enqueuedAt = new Map<string, number>();
  let retries = 0;
  let dlq = 0;
  let completed = 0;
  let maxQueueDepth = 0;
  let stopped = false;

  const worker = new Worker(
    queueName,
    async (job) => {
      const started = enqueuedAt.get(job.id ?? "") ?? Date.now();
      const result = await postWithTimeout(sinkUrl, JSON.stringify(job.data));
      if (!result.ok) throw new Error(`delivery failed (status=${result.status})`);
      latencies.push(Date.now() - started);
    },
    {
      connection: redis.duplicate(),
      concurrency: CONCURRENCY,
      lockDuration: 30000,
    }
  );
  await worker.waitUntilReady();

  const done = new Promise<void>((resolve) => {
    const check = () => {
      if (completed + dlq >= burstSize) resolve();
    };
    events.on("completed", ({ jobId }) => {
      completed += 1;
      void jobId;
      check();
    });
    events.on("failed", ({ jobId }) => {
      // Every failure event is a retry (or a terminal DLQ arrival, split out
      // below via the job's attempt count).
      retries += 1;
      checkTerminal(jobId).then((terminal) => {
        if (terminal) {
          dlq += 1;
          check();
        }
      });
    });
    async function checkTerminal(jobId: string): Promise<boolean> {
      try {
        const j = await queue.getJob(jobId);
        if (!j) return false;
        return (j.attemptsMade + 1) >= MAX_ATTEMPTS;
      } catch {
        return false;
      }
    }
  });

  // Sample queue depth while the burst drains.
  const sampler = (async () => {
    while (!stopped) {
      try {
        const [waiting, active, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getDelayedCount(),
        ]);
        maxQueueDepth = Math.max(maxQueueDepth, waiting + active + delayed);
      } catch {
        // Redis blip mid-sample must not fail the run.
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  })();

  const t0 = Date.now();
  const enqueueStart = Date.now();
  await queue.addBulk(
    Array.from({ length: burstSize }, (_, i) => {
      const id = `burst-${burstSize}-${i}`;
      enqueuedAt.set(id, Date.now());
      return {
        name: "deliver-webhook",
        data: {
          subscriptionId: `burst-sub-${burstSize}`,
          topic: "disburse",
          deliveryId: id,
          attempt: 0,
        },
        opts: {
          jobId: id,
          attempts: MAX_ATTEMPTS,
          backoff: { type: "exponential", delay: 1000 },
        },
      };
    })
  );
  const enqueueMs = Date.now() - enqueueStart;

  // Guard: never hang CI — 5 minutes per level is enough to prove the ceiling.
  await Promise.race([
    done,
    new Promise<void>((resolve) => setTimeout(resolve, 5 * 60 * 1000)),
  ]);
  stopped = true;
  await sampler.catch(() => undefined);
  const wallMs = Date.now() - t0;

  await worker.close().catch(() => undefined);
  await events.close().catch(() => undefined);
  // Remove leftover delayed retries so one level never pollutes the next.
  await queue.drain().catch(() => undefined);
  await queue.close().catch(() => undefined);

  // retries counted every failure event includes terminal DLQ failures; split them.
  const terminalDlq = dlq;
  const retryCount = Math.max(0, retries - terminalDlq);
  latencies.sort((a, b) => a - b);
  const p95 = percentile(latencies, 0.95);

  const breaches: string[] = [];
  if (p95 > P95_SLA_MS) breaches.push(`p95 ${p95.toFixed(0)}ms > SLA ${P95_SLA_MS}ms`);
  if (terminalDlq > 0 && SINK_FAIL_RATE === 0)
    breaches.push(`${terminalDlq} deliveries reached DLQ on a healthy subscriber`);

  return {
    burstSize,
    concurrency: CONCURRENCY,
    wallMs,
    enqueuedPerSec: (burstSize / Math.max(1, enqueueMs)) * 1000,
    deliveredPerSec: (completed / Math.max(1, wallMs)) * 1000,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95,
      max: latencies[latencies.length - 1] ?? 0,
      mean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0,
    },
    maxQueueDepth,
    retries: retryCount,
    dlq: terminalDlq,
    slaBreached: breaches.length > 0,
    breachReason: breaches.join("; "),
  };
}

async function main(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║   RemitMortgage — Webhook Delivery Burst Load Test (#761)    ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(`  Redis        : ${REDIS_URL}`);
  console.log(`  Levels       : ${LEVELS.join(", ")} deliveries/burst`);
  console.log(`  Concurrency  : ${CONCURRENCY} (production worker default: 20)`);
  console.log(`  Sink latency : ${SINK_LATENCY_MS}ms, fail rate: ${SINK_FAIL_RATE}`);
  console.log(`  p95 SLA      : ${P95_SLA_MS}ms  (ENFORCE_SLA=${ENFORCE_SLA ? "1" : "0"})\n`);

  const sink = await startSink();
  // BullMQ requires maxRetriesPerRequest: null on all clients.
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  const results: BurstLevelResult[] = [];

  try {
    for (const level of LEVELS) {
      console.log(`\n── Burst: ${level} deliveries ──`);
      const r = await runLevel(level, sink.url, redis);
      results.push(r);
      console.log(
        `  delivered ${r.deliveredPerSec.toFixed(1)}/s | p50=${r.latencyMs.p50.toFixed(0)}ms ` +
          `p95=${r.latencyMs.p95.toFixed(0)}ms max=${r.latencyMs.max.toFixed(0)}ms | ` +
          `maxDepth=${r.maxQueueDepth} retries=${r.retries} dlq=${r.dlq} ` +
          `${r.slaBreached ? `❌ BREACH (${r.breachReason})` : "✅ within SLA"}`
      );
      if (r.slaBreached) break; // Ceiling found — larger bursts only repeat the failure.
    }
  } finally {
    await sink.close();
    redis.disconnect();
  }

  const firstBreach = results.find((r) => r.slaBreached);
  const ceiling = firstBreach
    ? results[results.indexOf(firstBreach) - 1] ?? null
    : results[results.length - 1];
  console.log("\n════════ SUMMARY ════════");
  if (ceiling) {
    console.log(
      `  Tested safe ceiling: ~${ceiling.burstSize} deliveries/burst at ` +
        `${ceiling.deliveredPerSec.toFixed(1)}/s sustained ` +
        `(p95=${ceiling.latencyMs.p95.toFixed(0)}ms, maxDepth=${ceiling.maxQueueDepth}).`
    );
  }
  if (firstBreach) {
    console.log(
      `  Degradation point: ${firstBreach.burstSize}/burst — ${firstBreach.breachReason}. ` +
        `Apply backpressure below this point (see docs/WEBHOOK_THROUGHPUT_CEILING.md).`
    );
  } else {
    console.log("  No degradation observed at the tested levels.");
  }

  const outDir = path.join(process.cwd(), "load-tests", "results");
  await fs.mkdir(outDir, { recursive: true }).catch(() => undefined);
  const outFile = path.join(outDir, `webhook-burst-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await fs
    .writeFile(outFile, JSON.stringify({ at: new Date().toISOString(), results }, null, 2), "utf8")
    .catch(() => undefined);
  console.log(`  Report: ${outFile}`);

  if (ENFORCE_SLA && firstBreach) {
    console.error("❌ Webhook burst SLA breached and ENFORCE_SLA=1.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Webhook burst load test crashed:", err?.message ?? err);
  console.error("Hint: start Redis first (docker compose up redis) or set REDIS_URL.");
  process.exit(2);
});
