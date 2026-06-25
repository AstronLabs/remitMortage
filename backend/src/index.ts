import "dotenv/config";
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import rTracer from "cls-rtracer";
import { swaggerSpec } from "./docs/swagger.js";
import { healthRouter } from "./routes/health.js";
import { verificationRouter } from "./routes/verification.js";
import { borrowerRouter } from "./routes/borrower.js";
import { loanRouter } from "./routes/loan.js";
import { milestoneRouter } from "./routes/milestone.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { startNotificationScheduler } from "./services/notification.js";
import { loadConfig } from "./config.js";
import logger from "./utils/logger.js";

const app = express();
const config = loadConfig();
const PORT = config.port;

// ── Middleware ───────────────────────────────────────────────────────────
app.use(rTracer.expressMiddleware());
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
app.use("/api/health", healthRouter);
app.use("/api/verification", verificationLimiter, verificationRouter);
app.use("/api/borrower", borrowerRouter);
app.use("/api/loan", loanRouter);
app.use("/api/milestone", milestoneRouter);
app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Global error handler (must be after routes)
app.use(errorHandler);

// ── Start Server ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`RemitMortgage API running on http://localhost:${PORT}`);
  startNotificationScheduler();
});

export default app;
