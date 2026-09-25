// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Web Push subscription management.
 *
 * Wraps the browser's Push API so the rest of the app never has to deal with
 * `PushManager` directly. Everything here is guarded for environments where
 * push is unavailable — SSR, Safari without permission, browsers with
 * notifications disabled — because these APIs are missing rather than merely
 * failing in all of those cases.
 *
 * Subscription endpoints and topic preferences are persisted to the backend
 * notification service, which is what decides whether a given event is
 * actually delivered to a given device.
 */

/** Event types a user can opt into receiving as a browser push. */
export const PUSH_TOPICS = [
  "milestoneApproved",
  "milestoneProposed",
  "paymentDue",
  "paymentMissed",
  "paymentReceived",
  "loanApproved",
  "disbursement",
  "escrowTargetReached",
] as const;

export type PushTopic = (typeof PUSH_TOPICS)[number];

/** Which topics a subscriber wants delivered. */
export type PushPreferences = Record<PushTopic, boolean>;

export interface PushTopicDetail {
  label: string;
  description: string;
  group: "milestones" | "payments" | "loan";
}

/** Copy for the preferences panel, grouped the way the settings UI renders it. */
export const PUSH_TOPIC_DETAILS: Record<PushTopic, PushTopicDetail> = {
  milestoneApproved: {
    label: "Milestone approved",
    description: "A construction milestone cleared multisig approval",
    group: "milestones",
  },
  milestoneProposed: {
    label: "Milestone submitted",
    description: "Your contractor uploaded proof for a milestone",
    group: "milestones",
  },
  disbursement: {
    label: "Funds disbursed",
    description: "A tranche was released from the lending pool",
    group: "milestones",
  },
  paymentDue: {
    label: "Payment due",
    description: "A repayment installment is coming up",
    group: "payments",
  },
  paymentMissed: {
    label: "Payment missed",
    description: "An installment passed its due date",
    group: "payments",
  },
  paymentReceived: {
    label: "Payment received",
    description: "A repayment was confirmed on-chain",
    group: "payments",
  },
  loanApproved: {
    label: "Loan decision",
    description: "Your loan application was approved or updated",
    group: "loan",
  },
  escrowTargetReached: {
    label: "Savings target reached",
    description: "Your down-payment goal is fully funded",
    group: "loan",
  },
};

/** Everything on by default — the user already opted in by granting permission. */
export function defaultPushPreferences(): PushPreferences {
  return PUSH_TOPICS.reduce((acc, topic) => {
    acc[topic] = true;
    return acc;
  }, {} as PushPreferences);
}

/**
 * Normalizes an arbitrary stored object into a complete preference map.
 *
 * Preferences round-trip through the backend, so a payload may predate a topic
 * that has since been added. Missing keys default to enabled rather than
 * silently muting a topic the user never turned off.
 */
export function normalizePushPreferences(raw: unknown): PushPreferences {
  const source = (raw ?? {}) as Record<string, unknown>;
  return PUSH_TOPICS.reduce((acc, topic) => {
    acc[topic] = typeof source[topic] === "boolean" ? (source[topic] as boolean) : true;
    return acc;
  }, {} as PushPreferences);
}

/** True when this browser can actually register a push subscription. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Current notification permission, or `"unsupported"` off-browser. */
export function getPermissionState(): NotificationPermission | "unsupported" {
  if (!isPushSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * Converts a base64url VAPID key into the `Uint8Array` `PushManager` expects.
 *
 * The Push API predates widespread base64url support, so the padding and the
 * `-`/`_` characters have to be normalized by hand.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);

  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

/** Shape persisted to the backend for a device. */
export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Reduces a `PushSubscription` to the fields the server needs to send a push.
 *
 * Returns `null` when the browser hands back a subscription without encryption
 * keys, which cannot be delivered to and so is not worth persisting.
 */
export function serializeSubscription(
  subscription: PushSubscription
): StoredPushSubscription | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;

  if (!json.endpoint || !p256dh || !auth) {
    return null;
  }

  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** Path of the worker that handles `push` and `notificationclick`. */
const SERVICE_WORKER_URL = "/service-worker.js";

/**
 * Returns a ready service worker registration, registering one if needed.
 *
 * `navigator.serviceWorker.ready` never resolves when nothing has been
 * registered, so awaiting it directly would hang the subscribe flow forever.
 * Registering first makes push self-sufficient rather than depending on some
 * other part of the app having already done it.
 */
export async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  if (!existing) {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL);
  }
  return navigator.serviceWorker.ready;
}

/** Reads the existing subscription for this browser, if any. */
export async function getExistingSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_URL);
  // Deliberately does not register: reading current state should never install
  // a worker as a side effect of rendering the settings panel.
  if (!registration) return null;
  return registration.pushManager.getSubscription();
}

export class PushError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushError";
  }
}

/**
 * Requests permission and registers a push subscription.
 *
 * Reuses an existing subscription when one is present so repeated calls do not
 * churn endpoints on the push service.
 *
 * @throws {PushError} when push is unsupported, permission is denied, or no
 *         VAPID key is configured.
 */
export async function subscribeToPush(
  vapidPublicKey: string | undefined
): Promise<StoredPushSubscription> {
  if (!isPushSupported()) {
    throw new PushError("Push notifications are not supported in this browser.");
  }
  if (!vapidPublicKey) {
    throw new PushError("Push notifications are not configured for this deployment.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new PushError(
      permission === "denied"
        ? "Notification permission was blocked. Enable it in your browser settings."
        : "Notification permission was dismissed."
    );
  }

  const registration = await ensureServiceWorkerRegistration();

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const serialized = serializeSubscription(subscription);
  if (!serialized) {
    throw new PushError("The browser returned an unusable push subscription.");
  }
  return serialized;
}

/**
 * Tears down this browser's push subscription.
 *
 * Returns the endpoint that was removed so the caller can tell the backend
 * which record to drop, or `null` if there was nothing subscribed.
 */
export async function unsubscribeFromPush(): Promise<string | null> {
  const subscription = await getExistingSubscription();
  if (!subscription) return null;

  const { endpoint } = subscription;
  await subscription.unsubscribe();
  return endpoint;
}

// ── Backend persistence ────────────────────────────────────────────────────

const PUSH_API = "/api/notifications/push";

/** Persists a device subscription plus its topic preferences. */
export async function savePushSubscription(params: {
  address: string;
  subscription: StoredPushSubscription;
  preferences: PushPreferences;
}): Promise<void> {
  const res = await fetch(PUSH_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new PushError("Could not save your push subscription. Please try again.");
  }
}

/** Updates only the topic preferences for an already-registered device. */
export async function savePushPreferences(params: {
  address: string;
  endpoint: string;
  preferences: PushPreferences;
}): Promise<void> {
  const res = await fetch(PUSH_API, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new PushError("Could not update your notification preferences.");
  }
}

/** Removes a device subscription from the backend. */
export async function deletePushSubscription(params: {
  address: string;
  endpoint: string;
}): Promise<void> {
  await fetch(PUSH_API, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
}

/** Loads stored preferences for an address, falling back to all-enabled. */
export async function loadPushPreferences(address: string): Promise<PushPreferences> {
  try {
    const res = await fetch(`${PUSH_API}?address=${encodeURIComponent(address)}`);
    if (!res.ok) return defaultPushPreferences();
    const data = await res.json();
    return normalizePushPreferences(data?.preferences);
  } catch {
    // Offline or backend down — the panel still renders with sane defaults.
    return defaultPushPreferences();
  }
}
