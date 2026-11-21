// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Published JSON Schemas for outbound webhook payloads (issue #990).
 *
 * Subscribers should not have to infer payload shape from prose. Every event
 * type and schema version has a schema served from
 * `GET /api/webhooks/schemas/:version/:topic`; the dispatcher validates each
 * payload against it before sending and refuses to deliver an invalid one.
 *
 * The validator below intentionally implements the small JSON Schema subset
 * these schemas use, so adding schemas needs no new dependency.
 */

import type { EventTopic } from "./webhook.js";

/** Mirrors `CURRENT_WEBHOOK_SCHEMA_VERSION` / `DEPRECATED_...` in webhook.ts. */
export const CURRENT_WEBHOOK_SCHEMA_VERSION = 2;
export const DEPRECATED_WEBHOOK_SCHEMA_VERSION = 1;

export const WEBHOOK_SCHEMA_VERSIONS = [
  DEPRECATED_WEBHOOK_SCHEMA_VERSION,
  CURRENT_WEBHOOK_SCHEMA_VERSION,
] as const;

export const WEBHOOK_EVENT_TOPICS: EventTopic[] = [
  "deposit",
  "withdraw",
  "release",
  "disburse",
  "repay",
];

type JsonObject = Record<string, unknown>;

export interface WebhookJsonSchema extends JsonObject {
  $schema: string;
  $id: string;
  title: string;
}

function eventDataSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    required: ["contractId", "borrower", "amount", "ledger"],
    properties: {
      contractId: { type: "string", minLength: 1 },
      borrower: { type: "string", minLength: 1 },
      amount: { type: "string", pattern: "^-?\\d+(?:\\.\\d+)?$" },
      ledger: { type: "integer", minimum: 0 },
    },
  };
}

function payloadSchema(version: number, topic: EventTopic): WebhookJsonSchema {
  const properties: JsonObject = {
    deliveryId: { type: "string", minLength: 1 },
    topic: { const: topic },
    timestamp: { type: "integer", minimum: 0 },
    data: eventDataSchema(),
  };
  if (version >= CURRENT_WEBHOOK_SCHEMA_VERSION) {
    properties.schemaVersion = { const: CURRENT_WEBHOOK_SCHEMA_VERSION };
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `https://remitmortgage.com/schemas/webhooks/v${version}/${topic}.json`,
    title: `RemitMortgage webhook payload v${version}: ${topic}`,
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const schemaCache = new Map<string, WebhookJsonSchema>();

function cacheKey(version: number, topic: EventTopic): string {
  return `${version}:${topic}`;
}

/** Schema for one event type and version, or null when either is unknown. */
export function getWebhookSchema(version: number, topic: string): WebhookJsonSchema | null {
  if (!(WEBHOOK_SCHEMA_VERSIONS as readonly number[]).includes(version)) return null;
  if (!(WEBHOOK_EVENT_TOPICS as string[]).includes(topic)) return null;

  const key = cacheKey(version, topic as EventTopic);
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const schema = payloadSchema(version, topic as EventTopic);
  schemaCache.set(key, schema);
  return schema;
}

export interface WebhookSchemaIndexEntry {
  version: number;
  topic: EventTopic;
  schema: WebhookJsonSchema;
}

/** Every published schema, optionally narrowed to one version. */
export function listWebhookSchemas(version?: number): WebhookSchemaIndexEntry[] {
  const versions =
    version === undefined
      ? [...WEBHOOK_SCHEMA_VERSIONS]
      : (WEBHOOK_SCHEMA_VERSIONS as readonly number[]).includes(version)
        ? [version]
        : [];

  const entries: WebhookSchemaIndexEntry[] = [];
  for (const v of versions) {
    for (const topic of WEBHOOK_EVENT_TOPICS) {
      const schema = getWebhookSchema(v, topic);
      if (schema) entries.push({ version: v, topic, schema });
    }
  }
  return entries;
}

export interface WebhookPayloadValidation {
  valid: boolean;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  return Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
}

function validateAgainstSchema(
  value: unknown,
  schema: JsonObject,
  path: string,
  errors: string[]
): void {
  if (!isPlainObject(schema)) return;

  if ("const" in schema && value !== schema.const) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
    return;
  }

  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }

  const type = schema.type;
  if (typeof type === "string") {
    const actual = isPlainObject(value) ? "object" : describe(value);
    const matches =
      (type === "object" && isPlainObject(value)) ||
      (type === "array" && Array.isArray(value)) ||
      (type === "string" && typeof value === "string") ||
      (type === "boolean" && typeof value === "boolean") ||
      (type === "null" && value === null) ||
      (type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (type === "number" && typeof value === "number" && Number.isFinite(value));

    if (!matches) {
      errors.push(`${path} must be ${type}, got ${actual}`);
      return;
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value && isPlainObject(childSchema)) {
        validateAgainstSchema(value[key], childSchema, `${path}.${key}`, errors);
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not an allowed property`);
      }
    }
  }

  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((item, index) =>
      validateAgainstSchema(item, schema.items as JsonObject, `${path}[${index}]`, errors)
    );
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} must match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }
}

/** Validate an outbound payload against the schema for its version and topic. */
export function validateWebhookPayload(
  version: number,
  topic: string,
  payload: unknown
): WebhookPayloadValidation {
  const schema = getWebhookSchema(version, topic);
  if (!schema) {
    return { valid: false, errors: [`no schema for version ${version}, topic ${topic}`] };
  }

  const errors: string[] = [];
  validateAgainstSchema(payload, schema as unknown as JsonObject, "payload", errors);
  return { valid: errors.length === 0, errors };
}

export class InvalidWebhookPayloadError extends Error {
  readonly code = "invalid_webhook_payload" as const;
  readonly errors: string[];

  constructor(version: number, topic: string, errors: string[]) {
    super(`webhook payload v${version}/${topic} does not match its schema: ${errors.join("; ")}`);
    this.name = "InvalidWebhookPayloadError";
    this.errors = errors;
  }
}

/** Throwing wrapper used on the delivery path to refuse invalid payloads. */
export function assertValidWebhookPayload(
  version: number,
  topic: string,
  payload: unknown
): void {
  const result = validateWebhookPayload(version, topic, payload);
  if (!result.valid) throw new InvalidWebhookPayloadError(version, topic, result.errors);
}
