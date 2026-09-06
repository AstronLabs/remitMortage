import { Request, Response, NextFunction } from "express";
import { logHttpRequest } from "../utils/logger.js";
import { CORRELATION_ID_HEADER, getCorrelationId } from "./correlationId.js";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startHrTime = process.hrtime.bigint();

  res.on("finish", () => {
    const endHrTime = process.hrtime.bigint();
    const durationMs = Number(endHrTime - startHrTime) / 1e6;
    const message = `[Performance] ${req.method} ${req.originalUrl || req.url} - Status: ${res.statusCode} - ${durationMs.toFixed(
      2
    )}ms - IP: ${req.ip || req.socket.remoteAddress || "unknown"}`;

    // Ensure test suites that spy on console.info capture access logs
    console.info(message);
    logHttpRequest(
      req.method,
      req.originalUrl || req.url,
      res.statusCode,
      durationMs,
      {
        ip: req.ip || req.socket.remoteAddress || "unknown",
        userAgent: req.get("user-agent"),
        correlationId:
          getCorrelationId() ?? res.getHeader(CORRELATION_ID_HEADER) ?? "none",
      }
    );
  });

  next();
}
