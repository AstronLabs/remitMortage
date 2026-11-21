// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Per-event-type notification channels (issue #1116).
 *
 * Notification preferences used to carry a single global channel choice
 * (`emailAlerts` / `smsAlerts`) applied to every event type. Each event type
 * now has its own set of channels, and a type may use more than one.
 *
 * Migration: a user whose stored preferences predate this change has no
 * `eventChannels`, so every event type is seeded from their global setting —
 * nobody's notification behaviour changes until they edit it themselves.
 */

export const NOTIFICATION_CHANNELS = ["email", "sms"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const CHANNEL_EVENT_TYPES = [
  "escrowApproaching",
  "escrowReached",
  "paymentMissed",
  "loanMilestones",
  "loanApproval",
  "governanceAlerts",
] as const;
export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];

export type EventChannels = Record<ChannelEventType, NotificationChannel[]>;

export const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  email: "Email",
  sms: "SMS",
};

export const EVENT_TYPE_LABELS: Record<ChannelEventType, string> = {
  escrowApproaching: "Down-Payment Target Approaching",
  escrowReached: "Down-Payment Target Reached",
  paymentMissed: "Missed Payment Warning",
  loanMilestones: "Construction Milestone Updates",
  loanApproval: "Loan Status & Approval",
  governanceAlerts: "Governance Proposals",
};

/** The legacy global channel flags. */
export interface GlobalChannelFlags {
  emailAlerts?: boolean;
  smsAlerts?: boolean;
}

/** Defaults the legacy global settings fell back to: email on, SMS off. */
const DEFAULT_GLOBAL_FLAGS: Required<GlobalChannelFlags> = { emailAlerts: true, smsAlerts: false };

function isChannel(value: unknown): value is NotificationChannel {
  return typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

function isEventType(value: string): value is ChannelEventType {
  return (CHANNEL_EVENT_TYPES as readonly string[]).includes(value);
}

/** Channels in canonical order, de-duplicated. */
function normalizeChannels(channels: readonly NotificationChannel[]): NotificationChannel[] {
  return NOTIFICATION_CHANNELS.filter((c) => channels.includes(c));
}

/** The channel set the old global setting implied for every event type. */
export function channelsFromGlobalFlags(flags: GlobalChannelFlags = {}): NotificationChannel[] {
  const emailAlerts = flags.emailAlerts ?? DEFAULT_GLOBAL_FLAGS.emailAlerts;
  const smsAlerts = flags.smsAlerts ?? DEFAULT_GLOBAL_FLAGS.smsAlerts;
  return [...(emailAlerts ? (["email"] as const) : []), ...(smsAlerts ? (["sms"] as const) : [])];
}

/**
 * Validates a client-supplied `eventChannels` map: a partial record of known
 * event types to arrays of known channels. Returns an error message, or null
 * when valid.
 */
export function validateEventChannels(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "eventChannels must be an object keyed by event type.";
  }
  for (const [type, channels] of Object.entries(value)) {
    if (!isEventType(type)) {
      return `Unknown event type "${type}". Expected one of: ${CHANNEL_EVENT_TYPES.join(", ")}.`;
    }
    if (!Array.isArray(channels) || !channels.every(isChannel)) {
      return `eventChannels.${type} must be a list of channels from: ${NOTIFICATION_CHANNELS.join(", ")}.`;
    }
  }
  return null;
}

/**
 * Resolves the per-event-type channels for a stored preference record.
 * Event types present in `eventChannels` keep their explicit choice (even an
 * empty one); any type missing — including every type for a user who has
 * never saved per-type channels — is seeded from the global flags.
 */
export function resolveEventChannels(
  prefs: GlobalChannelFlags & { eventChannels?: Partial<Record<string, unknown>> | null } = {}
): EventChannels {
  const fallback = channelsFromGlobalFlags(prefs);
  const stored = prefs.eventChannels ?? {};
  const resolved = {} as EventChannels;
  for (const type of CHANNEL_EVENT_TYPES) {
    const explicit = stored[type];
    resolved[type] =
      Array.isArray(explicit) && explicit.every(isChannel) ? normalizeChannels(explicit) : [...fallback];
  }
  return resolved;
}

/** Adds or removes one channel for one event type, leaving every other type untouched. */
export function toggleEventChannel(
  current: EventChannels,
  type: ChannelEventType,
  channel: NotificationChannel
): EventChannels {
  const channels = current[type];
  const next = channels.includes(channel) ? channels.filter((c) => c !== channel) : [...channels, channel];
  return { ...current, [type]: normalizeChannels(next) };
}

/**
 * Legacy global flags kept in sync for consumers that still read them: a
 * channel is "on" globally if any event type uses it.
 */
export function globalFlagsFromEventChannels(eventChannels: EventChannels): Required<GlobalChannelFlags> {
  const used = new Set(Object.values(eventChannels).flat());
  return { emailAlerts: used.has("email"), smsAlerts: used.has("sms") };
}
