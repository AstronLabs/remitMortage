# Webhook Payload Schemas

Every outbound webhook payload has a published JSON Schema (draft 2020-12).
Schemas are versioned independently of the API: `v1` predates the
`schemaVersion` field, `v2` includes `schemaVersion: 2`.

## Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /api/webhooks/schemas` | Index of versions, topics and schema URLs |
| `GET /api/webhooks/schemas/:version` | All topics for one version |
| `GET /api/webhooks/schemas/:version/:topic` | One topic's schema |

Topics: `deposit`, `withdraw`, `release`, `disburse`, `repay`.

## Validation

The dispatcher validates each shaped payload against the schema for the
subscription's `webhookSchemaVersion` before it is sent. A payload that does
not match is written to the webhook DLQ and is **not** delivered — an invalid
payload is a code bug, not a transient failure, so it is not retried.

`backend/src/services/webhookSchemas.ts` exposes the same validation used in
production (`validateWebhookPayload`, `assertValidWebhookPayload`), and
`backend/src/__tests__/webhookSchemas.test.ts` builds a payload for every
version/topic pair so a schema change that no longer matches the dispatcher
fails CI.
