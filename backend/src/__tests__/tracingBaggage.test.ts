// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import express, { type RequestHandler } from "express";
import request from "supertest";
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import {
  BAGGAGE_TENANT_ID_KEY,
  BAGGAGE_USER_ID_KEY,
  runWithUserBaggage,
  tracingBaggageMiddleware,
} from "../middleware/tracingBaggage";
import { tenantContext } from "../services/tenant";

jest.mock("../config", () => ({
  loadConfig: () => ({
    smtpFrom: "no-reply@remitmortgage.com",
    tenantBranding: [
      {
        id: "acme",
        name: "Acme Homes",
        legalEntity: "Acme Lending LLC",
        senderDomain: "acme.com",
        colors: { header: "#112233", primary: "#ff6600" },
        hosts: ["loans.acme.com"],
      },
    ],
  }),
}));

const USER_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

beforeAll(() => {
  // Mirror how NodeSDK wires propagation: an AsyncLocalStorage-backed context
  // manager plus the W3C trace-context and baggage propagators. Without these,
  // baggage would be stored on a discarded context and never reach the wire.
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    })
  );
});

afterAll(() => {
  context.disable();
  propagation.disable();
});

/**
 * A handler that injects the active context — exactly what the HTTP
 * instrumentation does for a downstream call — and reports the baggage header
 * it would have sent.
 */
const injectOutbound: RequestHandler = (_req, res) => {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  res.json({ baggage: carrier.baggage ?? "" });
};

/** Build an app wired like the real server (inbound extract -> tenant -> baggage). */
function buildApp(handler: RequestHandler) {
  const app = express();
  // Stand in for the OTel HTTP instrumentation extracting the inbound
  // propagation context, including any `baggage` header from an upstream hop.
  app.use((req, _res, next) => {
    const extracted = propagation.extract(context.active(), req.headers);
    context.with(extracted, () => next());
  });
  app.use(tenantContext);
  app.use(tracingBaggageMiddleware);
  app.get("/call", handler);
  return app;
}

describe("tracing baggage", () => {
  it("propagates the resolved tenant onto an outbound call", async () => {
    const app = buildApp(injectOutbound);

    const res = await request(app).get("/call").set("X-Tenant-Id", "acme");

    expect(res.status).toBe(200);
    expect(res.body.baggage).toContain(`${BAGGAGE_TENANT_ID_KEY}=acme`);
  });

  it("falls back to the default tenant when no tenant is specified", async () => {
    const app = buildApp(injectOutbound);

    const res = await request(app).get("/call");

    expect(res.body.baggage).toContain(`${BAGGAGE_TENANT_ID_KEY}=default`);
  });

  it("adds the authenticated user id after auth resolves, keeping the tenant", async () => {
    const app = express();
    app.use(tenantContext);
    app.use(tracingBaggageMiddleware);
    app.get("/call", (_req, res) => {
      // Stand in for authMiddleware: it sets the user, then continues the chain.
      runWithUserBaggage(USER_WALLET, () => {
        const carrier: Record<string, string> = {};
        propagation.inject(context.active(), carrier);
        res.json({ baggage: carrier.baggage ?? "" });
      });
    });

    const res = await request(app).get("/call").set("X-Tenant-Id", "acme");

    expect(res.body.baggage).toContain(`${BAGGAGE_TENANT_ID_KEY}=acme`);
    expect(res.body.baggage).toContain(`${BAGGAGE_USER_ID_KEY}=${USER_WALLET}`);
  });

  it("carries baggage set on an inbound request through to an outbound call", async () => {
    const app = buildApp(injectOutbound);

    const res = await request(app)
      .get("/call")
      .set("X-Tenant-Id", "acme")
      .set("baggage", "upstream.trace=abc123");

    expect(res.body.baggage).toContain("upstream.trace=abc123");
    expect(res.body.baggage).toContain(`${BAGGAGE_TENANT_ID_KEY}=acme`);
  });

  it("does not attach a user id for anonymous requests", async () => {
    const app = buildApp(injectOutbound);

    const res = await request(app).get("/call").set("X-Tenant-Id", "acme");

    expect(res.body.baggage).not.toContain(BAGGAGE_USER_ID_KEY);
  });
});
