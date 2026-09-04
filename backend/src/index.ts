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
import { verifyRouter } from "./routes/verify.js";
import { borrowerRouter } from "./routes/borrower.js";
import { loanRouter } from "./routes/loan.js";
import { milestoneRouter } from "./routes/milestone.js";
import { analyticsRouter } from "./routes/analytics.js";
import { auditRouter } from "./routes/audit.js";
import { kycRouter } from "./routes/kyc.js";
import { notificationsRouter } from "./routes/notifications.js";
import { didRouter } from "./routes/did.js";
import { adminRouter } from "./routes/admin.js";
import { adminAuthRouter } from "./routes/adminAuth.js";
import { workspaceRouter } from "./routes/workspace.js";
import { userRouter } from "./routes/user.js";
import { metricsRouter } from "./routes/metrics.js";
import { getTrackedConnectionLimit } from "./services/dbPoolMetrics.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { incidentWebhookRouter } from "./routes/incidentWebhooks.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { waitlistRouter } from "./routes/waitlist.js";
import { loanImportRouter } from "./routes/loanImport.js";
import { authRouter } from "./routes/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { logMasker } from "./middleware/logMasker.js";
import { correlationId } from "./middleware/correlationId.js";
import { httpMetricsMiddleware } from "./middleware/metricsMiddleware.js";
import { tracingMiddleware } from "./middleware/tracingMiddleware.js";
import { authMiddleware } from "./middleware/auth.js";
import { rlsMiddleware } from "./middleware/rls.js";
import { startEventIndexer } from "./services/eventIndexer.js";
import {
  globalRateLimiter,
  sensitiveRateLimiter,
  mutationRateLimiter,
} from "./middleware/rateLimit.js";
import { issueCsrfToken, csrfProtection, CSRF_COOKIE } from "./middleware/csrf.js";
import { startEventListener } from "./services/eventListener.js";
import { startNotificationScheduler } from "./services/notification.js";
import { startScheduler } from "./jobs/scheduler.js";
import { startBackupScheduler, startBackupCleanupScheduler } from "./jobs/backupScheduler.js";
import { startWebhookKeyRotationScheduler } from "./jobs/webhookKeyRotation.js";
import { startRpcHealthMonitor } from "./services/rpcHealthMonitor.js";
import { loadConfig } from "./config.js";
import logger from "./utils/logger.js";
import { feeEstimator } from "./services/feeEstimator.js";
import { initializeRedis } from "./services/redis.js";
import { checkPrismaMigrations } from "./utils/prismaCheck.js";
import { initializeRedisCluster, closeCluster } from "./services/redisCluster.js";
import { queueService } from "./services/queueService.js";
import { startNotificationWorker, stopNotificationWorker } from "./workers/notificationWorker.js";
import { startWebhookWorker, stopWebhookWorker } from "./workers/webhookWorker.js";
import { startAnalyticsWorker, stopAnalyticsWorker } from "./workers/analyticsWorker.js";

const app = express();
const config = loadConfig();
const PORT = config.port;

void initializeRedis();

// ── Prisma Schema Migration Check ───────────────────────────────────
// Verifies the Postgres schema matches the Prisma definition before the
// server starts accepting traffic.  In production, pending migrations are
// fatal — the process aborts with a clear message.
//
// Override via:
//   SKIP_PRISMA_CHECK=true   — skip the check entirely (CI, ephemeral envs)
if (!process.env.SKIP_PRISMA_CHECK) {
  const result = checkPrismaMigrations();
  if (!result.ok) {
    const isProduction = process.env.NODE_ENV === "production";
    const fatal = isProduction && result.pending > 0;
    if (fatal) {
      logger.error(
        `[prisma] ${result.message} ` +
        `Aborting boot — run "npx prisma migrate deploy" or "npm run db:migrate" to sync, then restart.`
      );
      process.exit(1);
    }
    logger.warn(result.message, { pending: result.pending, applied: result.applied });
  } else {
    logger.info(result.message);
  }
} else {
  logger.warn("[prisma] Schema check skipped via SKIP_PRISMA_CHECK");
}

// ── Background Queue Initialization ─────────────────────────────────
void (async () => {
  try {
    await initializeRedisCluster();
    await queueService.initialize();
    await Promise.all([
      startNotificationWorker(),
      startWebhookWorker(),
      startAnalyticsWorker(),
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
app.use(logMasker);
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

// Row-Level Security: sets PostgreSQL session tenant context per-request.
// Runs after cookie parsing so the auth token is available, but before any
// route handlers execute database queries.
app.use(rlsMiddleware);

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
app.use("/api/verify", verificationLimiter, verifyRouter);
app.use("/api/borrower", mutationRateLimiter, authMiddleware, borrowerRouter);
app.use("/api/loan", mutationRateLimiter, authMiddleware, loanRouter);
app.use("/api/loan/import", mutationRateLimiter, authMiddleware, loanImportRouter);
app.use("/api/milestone", mutationRateLimiter, milestoneRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/did", sensitiveRateLimiter, didRouter);
app.use("/api/audit-logs", auditRouter);
// kycRouter applies its own per-route auth (borrower wallet auth on upload,
// operator API key on token issuance/decryption), so it is mounted bare.
app.use("/api/kyc", kycRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/referral", referralRouter);
app.use("/api/admin", authMiddleware, adminRouter);
app.use("/api/admin", adminAuthRouter);
app.use("/api/admin/api-keys", apiKeysRouter);
app.use("/api/webhooks/pagerduty", incidentWebhookRouter);
app.use("/api/webhooks", authMiddleware, webhooksRouter);
app.use("/api/user", userRouter);
app.use("/api/waitlist", waitlistRouter);
app.use("/api/auth", authRouter);
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
    // Logged so the pool ceiling the alerts are computed against is visible in
    // startup logs, not only on /metrics.
    dbConnectionLimit: getTrackedConnectionLimit(),
  });

  // Start the Soroban contract event indexer alongside the HTTP server. It
  // polls /getEvents and persists borrower activity into PostgreSQL.
  startEventIndexer();
  startNotificationScheduler();
  startScheduler();
  startBackupScheduler();
  startBackupCleanupScheduler();
  startWebhookKeyRotationScheduler();
  // Proactively monitor Soroban RPC node health and alert operators on
  // degradation, downtime or failover through the existing webhook mechanism.
  startRpcHealthMonitor();
  feeEstimator.start();
});

// ── Graceful Shutdown ─────────────────────────────────────────────────
async function shutdown(signal: string) {
  logger.info(`[shutdown] received ${signal}, shutting down gracefully`);
  await Promise.allSettled([
    stopNotificationWorker(),
    stopWebhookWorker(),
    stopAnalyticsWorker(),
    queueService.close(),
    closeCluster(),
  ]);
  logger.info("[shutdown] complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

export default app;
