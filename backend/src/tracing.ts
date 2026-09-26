// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * OpenTelemetry distributed tracing bootstrap.
 *
 * Exports every request's trace spans (HTTP, Express routing, Prisma calls)
 * to the OTLP collector provisioned in `infrastructure/terraform/apm`
 * (Jaeger, or any OTLP-compatible APM backend). Must be imported before any
 * other module — instrumentation patches libraries like `express` and `http`
 * at require-time, so it has to run first.
 *
 * Tracing is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset, so this is
 * safe to leave imported in local development.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-node";
import logger from "./utils/logger.js";

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (otlpEndpoint) {
  const serviceName = process.env.OTEL_SERVICE_NAME || "remitmortgage-backend";
  const sampleRatio = Number.parseFloat(process.env.OTEL_TRACES_SAMPLER_RATIO ?? "1.0");

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.1.0",
      "deployment.environment": process.env.NODE_ENV || "development",
    }),
    traceExporter: new OTLPTraceExporter({
      url: `${otlpEndpoint.replace(/\/$/, "")}/v1/traces`,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
        ? Object.fromEntries(
            process.env.OTEL_EXPORTER_OTLP_HEADERS.split(",").map((kv) => {
              const idx = kv.indexOf("=");
              return idx !== -1 ? [kv.slice(0, idx), kv.slice(idx + 1)] : [kv, ""];
            })
          )
        : undefined,
    }),
    sampler: new TraceIdRatioBasedSampler(
      Number.isFinite(sampleRatio) ? Math.min(Math.max(sampleRatio, 0), 1) : 1.0
    ),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Static asset noise isn't useful in an API-only service.
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  logger.info("[tracing] OpenTelemetry started", { serviceName, otlpEndpoint, sampleRatio });

  const shutdown = () => {
    sdk
      .shutdown()
      .then(() => logger.info("[tracing] OpenTelemetry shut down cleanly"))
      .catch((err) => logger.error("[tracing] error shutting down OpenTelemetry", { error: err }));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
} else {
  logger.info("[tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set — distributed tracing disabled");
}
