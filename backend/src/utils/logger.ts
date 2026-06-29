import winston from "winston";
import rTracer from "cls-rtracer";

const { combine, timestamp, json, colorize, simple, errors } = winston.format;

const isProduction = process.env.NODE_ENV === "production";

const requestIdFormat = winston.format((info) => {
  const id = rTracer.id();
  if (id) info.requestId = id;
  return info;
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    errors({ stack: true }),
    requestIdFormat(),
    timestamp(),
    isProduction ? json() : combine(colorize(), simple()),
  ),
  transports: [
    new winston.transports.Console({ stderrLevels: ["error"] }),
  ],
});

export default logger;
