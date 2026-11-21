// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js", () => ({ prisma: {} }));

import express from "express";
import request from "supertest";
import { shapeWebhookPayload, type WebhookPayload, type EventTopic } from "../services/webhook.js";
import {
  WEBHOOK_EVENT_TOPICS,
  WEBHOOK_SCHEMA_VERSIONS,
  assertValidWebhookPayload,
  getWebhookSchema,
  listWebhookSchemas,
  validateWebhookPayload,
} from "../services/webhookSchemas.js";
import { webhooksRouter } from "../routes/webhooks.js";

function samplePayload(topic: EventTopic): WebhookPayload {
  return {
    deliveryId: "delivery-1",
    topic,
    timestamp: 1_700_000_000_000,
    data: {
      contractId: "CABC",
      borrower: "GABC",
      amount: "123.45",
      ledger: 42,
    },
  };
}

describe("webhook payload schemas (#990)", () => {
  it("publishes a schema for every event type and version", () => {
    for (const version of WEBHOOK_SCHEMA_VERSIONS) {
      for (const topic of WEBHOOK_EVENT_TOPICS) {
        expect(getWebhookSchema(version, topic)).not.toBeNull();
      }
    }
    expect(listWebhookSchemas()).toHaveLength(
      WEBHOOK_SCHEMA_VERSIONS.length * WEBHOOK_EVENT_TOPICS.length
    );
  });

  it("matches every event payload the dispatcher can emit", () => {
    for (const version of WEBHOOK_SCHEMA_VERSIONS) {
      for (const topic of WEBHOOK_EVENT_TOPICS) {
        const shaped = shapeWebhookPayload(samplePayload(topic), version);
        expect(validateWebhookPayload(version, topic, shaped)).toEqual({ valid: true, errors: [] });
      }
    }
  });

  it("fails when a payload no longer matches its schema", () => {
    const version = 2;
    const shaped = shapeWebhookPayload(samplePayload("deposit"), version);

    const wrongType = { ...shaped, data: { ...(shaped.data as object), ledger: "forty-two" } };
    const result = validateWebhookPayload(version, "deposit", wrongType);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("payload.data.ledger");

    const extraField = { ...shaped, surprise: true };
    expect(validateWebhookPayload(version, "deposit", extraField).valid).toBe(false);

    expect(() => assertValidWebhookPayload(version, "deposit", wrongType)).toThrow(
      /does not match its schema/
    );
  });

  it("serves the schemas from a versioned public endpoint", async () => {
    const app = express();
    app.use("/api/webhooks", webhooksRouter);

    const index = await request(app).get("/api/webhooks/schemas");
    expect(index.status).toBe(200);
    expect(index.body.versions).toEqual([1, 2]);
    expect(index.body.schemas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: 2, topic: "deposit", url: "/api/webhooks/schemas/2/deposit" }),
      ])
    );

    const schema = await request(app).get("/api/webhooks/schemas/2/deposit");
    expect(schema.status).toBe(200);
    expect(schema.body.properties.topic).toEqual({ const: "deposit" });
    expect(schema.body.properties.schemaVersion).toEqual({ const: 2 });

    const missing = await request(app).get("/api/webhooks/schemas/2/unknown");
    expect(missing.status).toBe(404);
  });
});
