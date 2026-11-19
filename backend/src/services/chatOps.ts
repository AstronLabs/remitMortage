// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Slack / Teams ChatOps integration for operational admin alerts (issue #860).
 *
 * Alerts are routed to provider channels per severity, posted as interactive
 * messages (a link plus an "Acknowledge" action), rate-limited per channel, and
 * acknowledged back through signed callbacks. Every callback verifies the
 * provider's request signature before it is trusted, so a forged
 * acknowledgement cannot silently clear an incident.
 *
 * The service takes an injected transport so routing, signature verification,
 * rate limiting and acknowledgement are unit-testable without network access.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import logger from "../utils/logger.js";
import { safeParseJson } from "../utils/safeObject.js";

export type AlertSeverity = "critical" | "high" | "medium" | "low";
export type ChatOpsProvider = "slack" | "teams";

export const SEVERITIES: readonly AlertSeverity[] = ["critical", "high", "medium", "low"];

export interface ChatOpsAlert {
  id: string;
  severity: AlertSeverity;
  title: string;
  summary?: string;
  /** Deep link to the alert/incident. */
  url?: string;
  runbookUrl?: string;
  environment?: string;
  metadata?: Record<string, string>;
}

export type ChatOpsRouting = Record<AlertSeverity, ChatOpsProvider[]>;

/** Default routing: critical fans out to Slack + Teams, high/medium to Slack. */
export const DEFAULT_ROUTING: ChatOpsRouting = {
  critical: ["slack", "teams"],
  high: ["slack"],
  medium: ["slack"],
  low: [],
};

export interface SlackChannelConfig {
  webhookUrl: string;
  signingSecret: string;
}

export interface TeamsChannelConfig {
  webhookUrl: string;
  signingSecret: string;
}

export interface ChatOpsConfig {
  routing?: ChatOpsRouting;
  slack?: SlackChannelConfig;
  teams?: TeamsChannelConfig;
  /** Outgoing messages allowed per provider per rolling minute. */
  rateLimitPerMinute?: number;
}

export function providersForSeverity(
  severity: AlertSeverity,
  routing: ChatOpsRouting = DEFAULT_ROUTING
): ChatOpsProvider[] {
  return routing[severity] ?? [];
}

/** Slack Block Kit message with a link button and an acknowledge button. */
export function buildSlackMessage(alert: ChatOpsAlert): Record<string, unknown> {
  const fields = [
    { type: "mrkdwn", text: `*Severity:*\n\`${alert.severity.toUpperCase()}\`` },
    { type: "mrkdwn", text: `*Alert ID:*\n\`${alert.id}\`` },
  ];
  if (alert.environment) {
    fields.push({ type: "mrkdwn", text: `*Environment:*\n\`${alert.environment}\`` });
  }

  const actions: Array<Record<string, unknown>> = [];
  if (alert.url) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "View alert", emoji: true },
      url: alert.url,
      style: "primary",
    });
  }
  if (alert.runbookUrl) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Runbook", emoji: true },
      url: alert.runbookUrl,
    });
  }
  actions.push({
    type: "button",
    text: { type: "plain_text", text: "Acknowledge", emoji: true },
    action_id: "chatops_ack",
    value: alert.id,
    style: "danger",
  });

  return {
    text: `[${
      alert.severity.toUpperCase()
    }] ${alert.title}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Alert: ${alert.title}`, emoji: true },
      },
      ...(alert.summary
        ? [{ type: "section", text: { type: "mrkdwn", text: alert.summary } }]
        : []),
      { type: "section", fields },
      { type: "actions", elements: actions },
    ],
  };
}

/** Teams adaptive-card message with a link and an acknowledge action. */
export function buildTeamsMessage(alert: ChatOpsAlert): Record<string, unknown> {
  const body: Array<Record<string, unknown>> = [
    {
      type: "TextBlock",
      size: "Large",
      weight: "Bolder",
      text: `[${alert.severity.toUpperCase()}] ${alert.title}`,
    },
  ];
  if (alert.summary) body.push({ type: "TextBlock", text: alert.summary, wrap: true });
  body.push({ type: "FactSet", facts: [{ title: "Alert ID", value: alert.id }] });

  const actions: Array<Record<string, unknown>> = [];
  if (alert.url) actions.push({ type: "Action.OpenUrl", title: "View alert", url: alert.url });
  actions.push({
    type: "Action.Submit",
    title: "Acknowledge",
    data: { action: "chatops_ack", alertId: alert.id },
  });

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { type: "AdaptiveCard", version: "1.4", body, actions },
      },
    ],
  };
}

export interface SlackSignatureInput {
  signingSecret: string;
  /** `X-Slack-Request-Timestamp` header value (unix seconds, as a string). */
  timestamp: string;
  /** Raw request body, exactly as received. */
  body: string;
  /** `X-Slack-Signature` header value, `v0=<hex>`. */
  signature: string;
}

const SLACK_MAX_SKEW_SECONDS = 300;

/** Verifies a Slack request signature (v0 HMAC-SHA256) and timestamp skew. */
export function verifySlackSignature(
  input: SlackSignatureInput,
  now: number = Date.now()
): boolean {
  const { signingSecret, timestamp, body, signature } = input;
  if (!signingSecret || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(now / 1000 - ts) > SLACK_MAX_SKEW_SECONDS) return false;

  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return safeEqual(expected, signature);
}

export interface TeamsSignatureInput {
  signingSecret: string;
  /** Raw request body. */
  body: string;
  /** `Authorization` header value, `HMAC <base64>`. */
  signature: string;
}

/** Verifies a Teams outgoing-webhook HMAC-SHA256 (base64) signature. */
export function verifyTeamsSignature(input: TeamsSignatureInput): boolean {
  const { signingSecret, body, signature } = input;
  if (!signingSecret || !signature) return false;

  const provided = signature.startsWith("HMAC ") ? signature.slice(5).trim() : signature;
  const expected = createHmac("sha256", signingSecret).update(body).digest("base64");
  return safeEqual(expected, provided);
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Sliding-window rate limiter (per key, per rolling minute). */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(private readonly limitPerMinute: number, private readonly windowMs = 60_000) {}

  tryConsume(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limitPerMinute) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

export interface ChatOpsTransport {
  post(
    provider: ChatOpsProvider,
    webhookUrl: string,
    payload: Record<string, unknown>
  ): Promise<boolean>;
}

/** Default transport: POST JSON to the configured webhook. */
export class FetchChatOpsTransport implements ChatOpsTransport {
  async post(
    _provider: ChatOpsProvider,
    webhookUrl: string,
    payload: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return res.ok;
    } catch (error) {
      logger.error("[chatops] webhook delivery failed", { error });
      return false;
    }
  }
}

export interface DispatchResult {
  delivered: ChatOpsProvider[];
  skipped: Array<{ provider: ChatOpsProvider; reason: "not_routed" | "rate_limited" | "not_configured" | "delivery_failed" }>;
}

export interface AckRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
}

export type AckResult =
  | { ok: true; alertId: string }
  | { ok: false; status: number; error: string };

export class ChatOpsService {
  private readonly routing: ChatOpsRouting;
  private readonly slack?: SlackChannelConfig;
  private readonly teams?: TeamsChannelConfig;
  private readonly limiter: RateLimiter;
  private readonly transport: ChatOpsTransport;
  private readonly acknowledged = new Set<string>();

  constructor(config: ChatOpsConfig = {}, transport: ChatOpsTransport = new FetchChatOpsTransport()) {
    this.routing = config.routing ?? DEFAULT_ROUTING;
    this.slack = config.slack;
    this.teams = config.teams;
    this.limiter = new RateLimiter(config.rateLimitPerMinute ?? 30);
    this.transport = transport;
  }

  /** Routes, rate-limits and delivers an alert to its provider channels. */
  async dispatch(alert: ChatOpsAlert, now: number = Date.now()): Promise<DispatchResult> {
    const providers = providersForSeverity(alert.severity, this.routing);
    const delivered: ChatOpsProvider[] = [];
    const skipped: DispatchResult["skipped"] = [];

    for (const provider of providers) {
      const channel = provider === "slack" ? this.slack : this.teams;
      if (!channel?.webhookUrl) {
        skipped.push({ provider, reason: "not_configured" });
        continue;
      }
      if (!this.limiter.tryConsume(provider, now)) {
        skipped.push({ provider, reason: "rate_limited" });
        continue;
      }

      const payload =
        provider === "slack" ? buildSlackMessage(alert) : buildTeamsMessage(alert);
      const ok = await this.transport.post(provider, channel.webhookUrl, payload);
      if (ok) delivered.push(provider);
      else skipped.push({ provider, reason: "delivery_failed" });
    }

    return { delivered, skipped };
  }

  /** Verifies and processes an acknowledge callback from a provider. */
  handleAck(provider: ChatOpsProvider, req: AckRequest, now: number = Date.now()): AckResult {
    if (provider === "slack") {
      const signature = header(req.headers, "x-slack-signature") ?? "";
      const timestamp = header(req.headers, "x-slack-request-timestamp") ?? "";
      const valid =
        !!this.slack &&
        verifySlackSignature(
          { signingSecret: this.slack.signingSecret, timestamp, body: req.rawBody, signature },
          now
        );
      if (!valid) return { ok: false, status: 401, error: "invalid_signature" };
    } else {
      const signature = header(req.headers, "authorization") ?? "";
      const valid =
        !!this.teams &&
        verifyTeamsSignature({
          signingSecret: this.teams.signingSecret,
          body: req.rawBody,
          signature,
        });
      if (!valid) return { ok: false, status: 401, error: "invalid_signature" };
    }

    const alertId = extractAlertId(provider, req.rawBody);
    if (!alertId) return { ok: false, status: 400, error: "missing_alert_id" };

    this.acknowledged.add(alertId);
    logger.info("[chatops] alert acknowledged", { provider, alertId });
    return { ok: true, alertId };
  }

  isAcknowledged(alertId: string): boolean {
    return this.acknowledged.has(alertId);
  }

  /** Test helper. */
  reset(): void {
    this.acknowledged.clear();
  }
}

function header(
  headers: AckRequest["headers"],
  name: string
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Extracts the acknowledged alert id from a Slack or Teams callback body. */
export function extractAlertId(provider: ChatOpsProvider, rawBody: string): string | null {
  try {
    const parsed = safeParseJson<Record<string, any>>(rawBody);
    if (provider === "slack") {
      const action = parsed?.actions?.[0];
      return typeof action?.value === "string" ? action.value : null;
    }
    return typeof parsed?.data?.alertId === "string"
      ? parsed.data.alertId
      : typeof parsed?.value?.alertId === "string"
        ? parsed.value.alertId
        : null;
  } catch {
    return null;
  }
}

/** Configured singleton, wired from environment variables. */
export const chatOps = new ChatOpsService({
  slack: process.env.SLACK_WEBHOOK_URL
    ? {
        webhookUrl: process.env.SLACK_WEBHOOK_URL,
        signingSecret: process.env.SLACK_SIGNING_SECRET ?? "",
      }
    : undefined,
  teams: process.env.TEAMS_WEBHOOK_URL
    ? {
        webhookUrl: process.env.TEAMS_WEBHOOK_URL,
        signingSecret: process.env.TEAMS_SIGNING_SECRET ?? "",
      }
    : undefined,
  rateLimitPerMinute: Number(process.env.CHATOPS_RATE_LIMIT_PER_MINUTE || 30),
});

