/**
 * Webhook Dispatcher Service
 *
 * Responsibilities:
 *   1. Subscription CRUD  — create / list / pause / revoke / rotate-secret
 *   2. HMAC-SHA256 signing — every outbound request carries verifiable headers
 *   3. Dispatch with exponential-backoff retry — up to MAX_ATTEMPTS per delivery
 *   4. Delivery persistence — every attempt is written to WebhookDelivery
 *   5. Dead-letter queue   — permanently-failed deliveries also land in WebhookDLQ
 *   6. Key rotation        — signing keys auto-rotate every ROTATION_INTERVAL_DAYS;
 *      the previous key keeps validating for ROTATION_GRACE_PERIOD_DAYS so
 *      rotation never interrupts delivery verification (see
 *      `rotateDueSecrets`, `verifySubscriptionSignature`, and
 *      `jobs/webhookKeyRotation.ts` for the scheduled sweep).
 *
 * Signature scheme (compatible with Stripe / GitHub conventions):
 *
 *   signed_payload = "<timestamp>.<json_body>"
 *   signature      = HMAC-SHA256(secret, signed_payload).hex()
 *
 *   Headers sent:
 *     X-Webhook-Id        — WebhookDelivery.id  (idempotency key)
 *     X-Webhook-Timestamp — Unix epoch ms (string)
 *     X-Webhook-Topic     — event topic (e.g. "deposit")
 *     X-Webhook-Signature — "sha256=<hex>"
 *
 * Verification (receiver side, pseudo-code):
 *
 *   expected = HMAC-SHA256(sharedSecret, timestamp + "." + rawBody).hex()
 *   safe_compare(expected, signature.replace("sha256=",""))
 *   assert abs(now - timestamp) < TOLERANCE_MS   // replay protection
 */

import crypto from "crypto";
import { prisma } from "./db.js";
import logger from "../utils/logger.js";
import { encrypt, decrypt } from "../utils/crypto.js";
import { queueService, WebhookJobData } from "./queueService.js";
import { loadConfig } from "../config.js";
import { correlationHeaders } from "../middleware/correlationId.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum delivery attempts before a delivery is moved to the DLQ. */
export const MAX_ATTEMPTS = 5;

/** How often a subscription's HMAC signing key is auto-rotated. */
export const ROTATION_INTERVAL_DAYS = 90;

/**
 * How long the previous signing key keeps validating after a rotation.
 * Gives subscribers a window to pick up the new secret before the old one
 * is pruned, so in-flight verification never breaks mid-rotation.
 */
export const ROTATION_GRACE_PERIOD_DAYS = 7;

/** Base delay for exponential backoff in milliseconds. */
const BASE_BACKOFF_MS = 1_000;

/** Hard cap on backoff delay (30 s). */
const MAX_BACKOFF_MS = 30_000;

/** Maximum bytes of response body stored in the delivery record. */
const MAX_RESPONSE_BODY_BYTES = 2_048;

/** Request timeout for outbound webhook HTTP calls (10 s). */
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventTopic =
  | "deposit"
  | "withdraw"
  | "release"
  | "disburse"
  | "repay";

export interface WebhookPayload {
  /** Delivery attempt id — can be used as an idempotency key. */
  deliveryId: string;
  /** Event topic that triggered this delivery. */
  topic: EventTopic;
  /** Unix epoch milliseconds when the dispatch was initiated. */
  timestamp: number;
  /** The on-chain event data. */
  data: {
    contractId: string;
    borrower: string;
    amount: string;
    ledger: number;
  };
}

export interface DispatchResult {
  deliveryId: string;
  success: boolean;
  attempt: number;
  statusCode?: number;
  error?: string;
}

export interface CreateSubscriptionInput {
  label: string;
  url: string;
  /** Defaults to ["all"] when omitted. */
  topics?: EventTopic[];
  ownerAddress?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute exponential backoff with full-jitter to spread retry storms.
 * attempt is 0-based (attempt 0 = first retry wait).
 */
function backoffMs(attempt: number): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter: random value in [0, base]
  return Math.floor(Math.random() * base);
}

/**
 * Generate the HMAC-SHA256 signature for an outbound request.
 *
 * @param secret    Per-subscription plaintext secret.
 * @param timestamp Unix epoch ms as a string.
 * @param body      JSON-serialised request body.
 * @returns         "sha256=<hex>" string suitable for the X-Webhook-Signature header.
 */
export function signPayload(
  secret: string,
  timestamp: string,
  body: string
): string {
  const signed = `${timestamp}.${body}`;
  const hex = crypto
    .createHmac("sha256", secret)
    .update(signed)
    .digest("hex");
  return hex;
}

/**
 * Verify an inbound webhook signature (for use by receivers / tests).
 *
 * @param secret         Shared secret.
 * @param timestamp      Value of X-Webhook-Timestamp header.
 * @param rawBody        Raw (unparsed) request body string.
 * @param signature      Value of X-Webhook-Signature header ("sha256=<hex>").
 * @param toleranceMs    Max acceptable clock skew in ms (default 5 min).
 */
export function verifySignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  toleranceMs = 5 * 60 * 1_000
): boolean {
  // Replay protection — reject stale timestamps.
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > toleranceMs) {
    return false;
  }

  // Accept either raw hex or the "sha256=<hex>" form.
  const sig = signature && signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = signPayload(secret, timestamp, rawBody);

  try {
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Perform a single HTTP POST attempt to a subscriber URL.
 * Returns the raw result; does NOT write to the database.
 */
async function attemptPost(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<{ statusCode: number; responseBody: string; error?: never } | { error: string; statusCode?: number; responseBody?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      // Forward the in-flight request's correlation ID so the subscriber's
      // logs join up with ours. Explicit `headers` still win if a caller
      // deliberately overrides the value.
      headers: {
        "Content-Type": "application/json",
        ...correlationHeaders(),
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    const raw = await res.text();
    const responseBody = raw.slice(0, MAX_RESPONSE_BODY_BYTES);

    return { statusCode: res.status, responseBody };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { error };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Subscription CRUD
// ---------------------------------------------------------------------------

/**
 * Create a new webhook subscription.
 *
 * A random 32-byte secret is generated and stored encrypted.
 * The plaintext secret is returned once here and never again — the caller
 * must deliver it to the subscriber securely.
 */
export async function createSubscription(
  input: CreateSubscriptionInput
): Promise<{ subscription: any; plaintextSecret: string }> {
  const plaintextSecret = crypto.randomBytes(32).toString("hex");
  const encryptedSecret = encrypt(plaintextSecret);

  const topics =
    input.topics && input.topics.length > 0 ? input.topics : ["all" as const];

  const subscription = await prisma.webhookSubscription.create({
    data: {
      label: input.label,
      url: input.url,
      secret: encryptedSecret,
      topics,
      ownerAddress: input.ownerAddress ?? null,
    },
  });

  return { subscription, plaintextSecret };
}

/** List all subscriptions, optionally filtered by owner address. */
export async function listSubscriptions(ownerAddress?: string): Promise<any[]> {
  const where = ownerAddress ? { ownerAddress } : {};
  const rows = await prisma.webhookSubscription.findMany({
    where,
    orderBy: { createdAt: "desc" },
    // Never return the encrypted secret in list responses.
    select: {
      id: true,
      label: true,
      url: true,
      topics: true,
      status: true,
      ownerAddress: true,
      createdAt: true,
      updatedAt: true,
      // Rotation status is safe to expose (unlike the keys themselves) and
      // lets admin tooling confirm rotations are landing on schedule.
      secretRotatedAt: true,
      previousSecretExpiresAt: true,
    },
  });
  return rows;
}

/** Fetch a single subscription by id (without exposing the secret). */
export async function getSubscription(id: string): Promise<any | null> {
  return prisma.webhookSubscription.findUnique({
    where: { id },
    select: {
      id: true,
      label: true,
      url: true,
      topics: true,
      status: true,
      ownerAddress: true,
      createdAt: true,
      updatedAt: true,
      // Rotation status is safe to expose (unlike the keys themselves) and
      // lets admin tooling confirm rotations are landing on schedule.
      secretRotatedAt: true,
      previousSecretExpiresAt: true,
    },
  });
}

/** Pause or revoke a subscription by id. */
export async function updateSubscriptionStatus(
  id: string,
  status: "active" | "paused" | "revoked"
): Promise<any> {
  return prisma.webhookSubscription.update({
    where: { id },
    data: { status, updatedAt: new Date() },
  });
}

/**
 * Rotate the HMAC secret for a subscription.
 *
 * The current secret is demoted to `previousSecret` rather than discarded —
 * it keeps validating for {@link ROTATION_GRACE_PERIOD_DAYS} so a subscriber
 * mid-transition doesn't see valid deliveries rejected. A brand-new secret
 * becomes the primary signing key immediately.
 *
 * Returns the new plaintext secret (shown once).
 */
export async function rotateSecret(
  id: string
): Promise<{ plaintextSecret: string }> {
  const existing = await prisma.webhookSubscription.findUnique({
    where: { id },
    select: { secret: true },
  });
  if (!existing) {
    throw new Error(`Subscription ${id} not found`);
  }

  const plaintextSecret = crypto.randomBytes(32).toString("hex");
  const encryptedSecret = encrypt(plaintextSecret);
  const now = new Date();
  const previousSecretExpiresAt = new Date(
    now.getTime() + ROTATION_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000
  );

  await prisma.webhookSubscription.update({
    where: { id },
    data: {
      previousSecret: existing.secret,
      previousSecretExpiresAt,
      secret: encryptedSecret,
      secretRotatedAt: now,
      updatedAt: now,
    },
  });

  return { plaintextSecret };
}

/**
 * Verifies a signature against a subscription's stored keys, accepting
 * either the current primary secret or — while still inside its grace
 * period — the previous one. This is what lets a rotation happen without
 * interrupting delivery verification for subscribers who haven't yet picked
 * up the new secret.
 */
export async function verifySubscriptionSignature(
  subscriptionId: string,
  timestamp: string,
  rawBody: string,
  signature: string
): Promise<boolean> {
  const sub = await prisma.webhookSubscription.findUnique({
    where: { id: subscriptionId },
    select: { secret: true, previousSecret: true, previousSecretExpiresAt: true },
  });
  if (!sub) return false;

  if (verifySignature(decrypt(sub.secret), timestamp, rawBody, signature)) {
    return true;
  }

  const previousStillValid =
    !!sub.previousSecret &&
    (!sub.previousSecretExpiresAt || sub.previousSecretExpiresAt > new Date());

  if (previousStillValid) {
    return verifySignature(decrypt(sub.previousSecret as string), timestamp, rawBody, signature);
  }

  return false;
}

/**
 * Clears `previousSecret` on every subscription whose grace period has
 * elapsed, so an outdated key never validates indefinitely. Returns the
 * number of subscriptions pruned.
 */
export async function pruneExpiredPreviousSecrets(): Promise<number> {
  const { count } = await prisma.webhookSubscription.updateMany({
    where: {
      previousSecret: { not: null },
      previousSecretExpiresAt: { lte: new Date() },
    },
    data: { previousSecret: null, previousSecretExpiresAt: null },
  });
  return count;
}

/**
 * Finds every non-revoked subscription whose signing key is due for
 * rotation (older than {@link ROTATION_INTERVAL_DAYS}) and rotates it.
 * Intended to be run on a recurring schedule; see `jobs/webhookKeyRotation.ts`.
 *
 * Returns the freshly-generated plaintext secret for each rotated
 * subscription, keyed by subscription id, so the caller can deliver it to an
 * operator immediately — it is never persisted or logged in plaintext, and
 * this is the only opportunity to retrieve it for an unattended rotation.
 */
export async function rotateDueSecrets(): Promise<{
  rotatedIds: string[];
  secrets: Record<string, string>;
}> {
  const cutoff = new Date(
    Date.now() - ROTATION_INTERVAL_DAYS * 24 * 60 * 60 * 1000
  );

  const due = await prisma.webhookSubscription.findMany({
    where: {
      status: { not: "revoked" },
      secretRotatedAt: { lte: cutoff },
    },
    select: { id: true },
  });

  const rotatedIds: string[] = [];
  const secrets: Record<string, string> = {};
  for (const sub of due) {
    const { plaintextSecret } = await rotateSecret(sub.id);
    rotatedIds.push(sub.id);
    secrets[sub.id] = plaintextSecret;
  }

  return { rotatedIds, secrets };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a contract event to all active subscriptions that match its topic.
 *
 * Each dispatch adds BullMQ jobs for load-balanced processing by webhook workers.
 * The function returns immediately — retries and failover are handled by the queue.
 */
export function dispatchEvent(
  topic: EventTopic,
  data: WebhookPayload["data"]
): void {
  // Run entirely in the background — never awaited by the event listener.
  void _dispatchEventAsync(topic, data).catch((err) => {
    logger.error("[webhook] unhandled dispatch error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

async function _dispatchEventAsync(
  topic: EventTopic,
  data: WebhookPayload["data"]
): Promise<void> {
  // Find all active subscriptions that subscribe to this topic or "all".
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      status: "active",
      topics: { hasSome: [topic, "all"] },
    },
  });

  if (subscriptions.length === 0) return;

  // Enqueue a BullMQ job per subscription for load-balanced delivery
  const results = await Promise.allSettled(
    subscriptions.map((sub: any) =>
      queueService.addWebhookJob({
        subscriptionId: sub.id,
        url: sub.url,
        encryptedSecret: sub.secret,
        topic,
        data,
      } as WebhookJobData, {
        attempts: MAX_ATTEMPTS,
        backoff: { type: "exponential", delay: BASE_BACKOFF_MS },
      })
    )
  );

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      logger.error("[webhook] failed to enqueue job", {
        subscriptionId: subscriptions[i]?.id,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

/**
 * Deliver one event to one subscriber, retrying up to MAX_ATTEMPTS times.
 * Each attempt is persisted as a WebhookDelivery row.
 */
async function _deliverToSubscription(
  subscription: { id: string; url: string; secret: string },
  topic: EventTopic,
  data: WebhookPayload["data"]
): Promise<void> {
  const plaintextSecret = decrypt(subscription.secret);

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const timestamp = String(Date.now());
    const deliveryId = crypto.randomUUID();

    const payload: WebhookPayload = {
      deliveryId,
      topic,
      timestamp: parseInt(timestamp, 10),
      data,
    };
    const body = JSON.stringify(payload);
    const signature = signPayload(plaintextSecret, timestamp, body);

    const headers: Record<string, string> = {
      "X-Webhook-Id": deliveryId,
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Topic": topic,
      "X-Webhook-Signature": signature,
    };

    const result = await attemptPost(subscription.url, headers, body);

    const success =
      "statusCode" in result &&
      result.statusCode !== undefined &&
      result.statusCode >= 200 &&
      result.statusCode < 300;

    const isTerminal = success || attempt === MAX_ATTEMPTS - 1;
    const nextRetryAt = isTerminal
      ? null
      : new Date(Date.now() + backoffMs(attempt));

    // Persist the attempt.
    await prisma.webhookDelivery.create({
      data: {
        id: deliveryId,
        subscriptionId: subscription.id,
        topic,
        payload: payload as any,
        statusCode: "statusCode" in result ? (result.statusCode ?? null) : null,
        responseBody:
          "responseBody" in result ? (result.responseBody ?? null) : null,
        error: "error" in result ? result.error : null,
        success,
        attempt,
        nextRetryAt,
      },
    });

    if (success) {
      logger.info("[webhook] delivered", {
        subscriptionId: subscription.id,
        deliveryId,
        topic,
        attempt,
        statusCode: (result as any).statusCode,
      });
      return;
    }

    const errorMsg =
      "error" in result
        ? result.error
        : `HTTP ${(result as any).statusCode}`;

    logger.warn("[webhook] delivery failed", {
      subscriptionId: subscription.id,
      deliveryId,
      topic,
      attempt,
      error: errorMsg,
    });

    if (isTerminal) {
      // All attempts exhausted — write to legacy DLQ for visibility.
      await prisma.webhookDLQ.create({
        data: {
          url: subscription.url,
          payload: payload as any,
          statusCode:
            "statusCode" in result ? (result.statusCode ?? null) : null,
          responsePayload:
            "responseBody" in result ? (result.responseBody ?? null) : null,
          error: "error" in result ? result.error : errorMsg,
        },
      });

      logger.error("[webhook] delivery permanently failed, added to DLQ", {
        subscriptionId: subscription.id,
        topic,
        url: subscription.url,
      });
      return;
    }

    // Wait before the next retry.
    const delay = backoffMs(attempt);
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Manually replay a specific delivery attempt.
 * Creates a fresh WebhookDelivery row using the original payload.
 * Useful for admin dashboards and debugging.
 */
export async function replayDelivery(deliveryId: string): Promise<DispatchResult> {
  const original = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { subscription: true },
  });

  if (!original) {
    throw new Error(`Delivery ${deliveryId} not found`);
  }

  const sub = original.subscription as { id: string; url: string; secret: string; status: string };

  if (sub.status === "revoked") {
    throw new Error("Cannot replay delivery for a revoked subscription");
  }

  const plaintextSecret = decrypt(sub.secret);
  const timestamp = String(Date.now());
  const newDeliveryId = crypto.randomUUID();

  const payload: WebhookPayload = {
    ...(original.payload as object),
    deliveryId: newDeliveryId,
    timestamp: parseInt(timestamp, 10),
  } as WebhookPayload;

  const body = JSON.stringify(payload);
  const signature = signPayload(plaintextSecret, timestamp, body);

  const headers: Record<string, string> = {
    "X-Webhook-Id": newDeliveryId,
    "X-Webhook-Timestamp": timestamp,
    "X-Webhook-Topic": original.topic,
    "X-Webhook-Signature": signature,
    "X-Webhook-Replay": "true",
  };

  const result = await attemptPost(sub.url, headers, body);

  const success =
    "statusCode" in result &&
    result.statusCode !== undefined &&
    result.statusCode >= 200 &&
    result.statusCode < 300;

  await prisma.webhookDelivery.create({
    data: {
      id: newDeliveryId,
      subscriptionId: sub.id,
      topic: original.topic,
      payload: payload as any,
      statusCode: "statusCode" in result ? (result.statusCode ?? null) : null,
      responseBody:
        "responseBody" in result ? (result.responseBody ?? null) : null,
      error: "error" in result ? result.error : null,
      success,
      attempt: original.attempt + 1,
      nextRetryAt: null,
    },
  });

  return {
    deliveryId: newDeliveryId,
    success,
    attempt: original.attempt + 1,
    statusCode: "statusCode" in result ? result.statusCode : undefined,
    error: "error" in result ? result.error : undefined,
  };
}

// ---------------------------------------------------------------------------
// Legacy single-shot helper (kept for backwards compatibility)
// ---------------------------------------------------------------------------

export interface WebhookResult {
  success: boolean;
  status?: number;
  responsePayload?: string;
  error?: string;
}

/**
 * @deprecated Use `dispatchEvent` for new code.
 * Sends a one-off signed webhook to a bare URL using the global webhook secret.
 */
export async function sendWebhook(
  url: string,
  payload: unknown
): Promise<WebhookResult> {
  const secret = loadConfig().webhookSecret;
  const timestamp = String(Date.now());
  const body = JSON.stringify(payload);
  const signature = signPayload(secret, timestamp, body);

  const result = await attemptPost(
    url,
    {
      "X-Webhook-Timestamp": timestamp,
      "X-Webhook-Signature": signature,
    },
    body
  );

  if ("error" in result) {
    logger.error(`[webhook] sendWebhook fetch failure to ${url}`, {
      error: result.error,
    });
    return { success: false, error: result.error };
  }

  if (result.statusCode < 200 || result.statusCode >= 300) {
    logger.error(`[webhook] sendWebhook HTTP error from ${url}`, {
      status: result.statusCode,
    });
    return {
      success: false,
      status: result.statusCode,
      responsePayload: result.responseBody,
    };
  }

  return {
    success: true,
    status: result.statusCode,
    responsePayload: result.responseBody,
  };
}
