# Webhook Signatures

Outgoing webhooks are signed so consumers can verify they originated from
RemitMortgage and were not replayed later.

## Signature Format

Each webhook request includes:

- `X-Webhook-Id` — unique delivery id (UUID), usable as an idempotency key
- `X-Webhook-Timestamp` — epoch milliseconds when the request was signed
- `X-Webhook-Topic` — event topic (`deposit`, `withdraw`, `release`, `disburse`, `repay`)
- `X-Webhook-Signature` — `sha256=<hex>` HMAC-SHA256 signature

The signed string is the timestamp, a literal `.`, and the raw request body:

```
signed_payload = "<timestamp>.<raw_body>"
signature      = HMAC-SHA256(secret, signed_payload)
```

Because the timestamp is part of the signed input, changing it invalidates the
signature.

## Verification

1. Read the **raw** request body (do not re-serialise parsed JSON).
2. Read `X-Webhook-Timestamp` and reject it when
   `abs(now - timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_MS`. The default window
   is 5 minutes; the sender's configured value is returned in the
   `/api/webhooks/verify` response as `toleranceMs`.
3. Compute `HMAC-SHA256(secret, timestamp + "." + rawBody)`.
4. Compare it with `X-Webhook-Signature` (`sha256=` prefix optional) using a
   constant-time comparison.

```ts
import crypto from "crypto";

function verify(secret: string, timestamp: string, rawBody: string, signature: string) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();
  const received = Buffer.from(signature.replace(/^sha256=/, ""), "hex");

  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}
```

The backend exposes the same logic as `verifyWebhookSignature` in
`backend/src/services/webhook.ts`, and
`POST /api/webhooks/verify` lets a receiver check an integration without
running the helper locally.

## Clock-skew configuration

| Variable | Default | Meaning |
|---|---|---|
| `WEBHOOK_SIGNATURE_TOLERANCE_MS` | `300000` (5 min) | Maximum accepted difference between the signed timestamp and the verifier's clock. Values above 24 hours are capped. |

A request outside the window fails verification even when its HMAC is correct,
so a captured request cannot be replayed indefinitely.

## Retry Policy

If a consumer responds with a non-2xx status, the webhook is retried up to 5
times with exponential backoff (capped at 30 seconds between attempts).

## Configuration

Set `WEBHOOK_SECRET` in the backend environment to a strong, unique value.
Per-subscription secrets replace it for subscription deliveries and rotate
every 90 days; the previous key keeps validating for 7 days after rotation.
