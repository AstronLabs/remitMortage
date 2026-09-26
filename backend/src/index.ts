import "dotenv/config";
// Must load before any other module — OpenTelemetry auto-instrumentation
// patches libraries (express, http, pg, etc.) at require-time.
import "./tracing.js";
import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 1.0,
});

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./docs/swagger.js";
import { healthRouter } from "./routes/health.js";
import { rpcHealthRouter } from "./routes/rpcHealth.js";
import { verificationRouter } from "./routes/verification.js";
import { borrowerRouter } from "./routes/borrower.js";
import { loanRouter } from "./routes/loan.js";
import { milestoneRouter } from "./routes/milestone.js";
import { analyticsRouter } from "./routes/analytics.js";
import { auditRouter } from "./routes/audit.js";
import { kycRouter } from "./routes/kyc.js";
import { didRouter } from "./routes/did.js";
import { adminRouter } from "./routes/admin.js";
import { workspaceRouter } from "./routes/workspace.js";
import { metricsRouter } from "./routes/metrics.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { correlationId } from "./middleware/correlationId.js";
import { httpMetricsMiddleware } from "./middleware/metricsMiddleware.js";
import { tracingMiddleware } from "./middleware/tracingMiddleware.js";
import { authMiddleware } from "./middleware/auth.js";
import {
  globalRateLimiter,
  sensitiveRateLimiter,
  mutationRateLimiter,
} from "./middleware/rateLimit.js";
import { issueCsrfToken, csrfProtection, CSRF_COOKIE } from "./middleware/csrf.js";
import { startEventListener } from "./services/eventListener.js";
import { startNotificationScheduler } from "./services/notification.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startBackupScheduler } from "./jobs/backupScheduler.js";
import { startWebhookKeyRotationScheduler } from "./jobs/webhookKeyRotation.js";
import {
  startIpfsOrphanCleanupScheduler,
  stopIpfsOrphanCleanupScheduler,
} from "./jobs/ipfsOrphanCleanup.js";
import { startRpcHealthMonitor } from "./services/rpcHealthMonitor.js";
import { loadConfig } from "./config.js";
import logger from "./utils/logger.js";
import { initializeRedis } from "./services/redis.js";
import { initializeRedisCluster, closeCluster } from "./services/redisCluster.js";
import { queueService } from "./services/queueService.js";
import { startNotificationWorker, stopNotificationWorker } from "./workers/notificationWorker.js";
import { startWebhookWorker, stopWebhookWorker } from "./workers/webhookWorker.js";

const app = express();
const config = loadConfig();
const PORT = config.port;

void initializeRedis();

// ── Background Queue Initialization ─────────────────────────────────
void (async () => {
  try {
    await initializeRedisCluster();
    await queueService.initialize();
    await Promise.all([
      startNotificationWorker(),
      startWebhookWorker(),
    ]);
    logger.info("[queue] BullMQ workers started", {
      mode: config.redisClusterEnabled ? "cluster" : "single",
    });
  } catch (err) {
    logger.error("[queue] failed to start workers, running without queue", { err });
  }
})();

// ── Middleware ───────────────────────────────────────────────────────────
// Correlation ID must be first so every downstream middleware, handler and
// log line for this request resolves the same trace ID.
app.use(correlationId);
// HTTP metrics must be first so the timer starts at the earliest possible point.
app.use(httpMetricsMiddleware);
app.use(tracingMiddleware);
app.use(requestLogger);
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, curl, Postman)
    if (!origin) {
      return callback(null, true);
    }
    
    if (config.allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Global rate limiter — caps naive request floods across the whole API before
// any route-specific limiter narrows it further.
app.use(globalRateLimiter);

// CSRF: issue a double-submit token cookie to every client, then reject
// state-mutating requests that authenticate via a session cookie without
// echoing the token back in the `x-csrf-token` header.
app.use(issueCsrfToken);
app.use(csrfProtection);

// Lets first-party clients read the current CSRF token (also delivered via the
// `csrfToken` cookie) to attach on subsequent mutating requests.
app.get("/api/csrf-token", (req, res) => {
  const csrfToken = (req as typeof req & { csrfToken?: string }).csrfToken;
  res.json({ csrfToken, cookieName: CSRF_COOKIE });
});

// Basic rate limiter for verification endpoints: 100 requests per minute per IP
const verificationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    res.status(429).json({ error: "Too many requests", statusCode: 429, timestamp: new Date().toISOString() });
  },
});

// ── Routes ──────────────────────────────────────────────────────────────
// /metrics is unauthenticated at the Express level — the route itself
// enforces bearer-token auth via metricsAuthMiddleware when METRICS_TOKEN is set.
app.use("/metrics", metricsRouter);
app.use("/api/health/rpc", rpcHealthRouter);
app.use("/api/health", healthRouter);
app.use("/api/verification", verificationLimiter, verificationRouter);
app.use("/api/borrower", mutationRateLimiter, authMiddleware, borrowerRouter);
app.use("/api/loan", mutationRateLimiter, authMiddleware, loanRouter);
app.use("/api/milestone", mutationRateLimiter, milestoneRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/did", sensitiveRateLimiter, didRouter);
app.use("/api/audit-logs", auditRouter);
app.use("/api/workspaces", workspaceRouter);
// kycRouter applies its own per-route auth (borrower wallet auth on upload,
// operator API key on token issuance/decryption), so it is mounted bare.
app.use("/api/kyc", kycRouter);
app.use("/api/admin", authMiddleware, adminRouter);
app.use("/api/webhooks", authMiddleware, webhooksRouter);
// Swagger UI — excluded from rate limits so developers can inspect freely
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Global error handler (must be after routes)
Sentry.setupExpressErrorHandler(app);
app.use(errorHandler);

// ── Start Server ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info("RemitMortgage API server started", {
    port: PORT,
    environment: process.env.NODE_ENV || "development",
  });

  // Start the Soroban contract event listener alongside the HTTP server. It
  // runs in the background and self-heals via exponential backoff, so a failing
  // RPC node never takes down the API process.
  startEventListener();
  startNotificationScheduler();
  startScheduler();
  startBackupScheduler();
  startWebhookKeyRotationScheduler();
  startIpfsOrphanCleanupScheduler();
  // Proactively monitor Soroban RPC node health and alert operators on
  // degradation, downtime or failover through the existing webhook mechanism.
  startRpcHealthMonitor();
});

// ── Graceful Shutdown ─────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`[shutdown] received ${signal}, shutting down gracefully`);
  stopIpfsOrphanCleanupScheduler();
  await Promise.allSettled([
    stopNotificationWorker(),
    stopWebhookWorker(),
    queueService.close(),
    closeCluster(),
  ]);
  logger.info("[shutdown] complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
