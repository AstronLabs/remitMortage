/**
 * Thin SendGrid client wrapper.
 *
 * Uses the official `@sendgrid/mail` client when it is installed, and otherwise
 * falls back to the same v3 Mail Send REST endpoint over axios so the alerting
 * service works without pulling in an extra runtime dependency.
 */

import axios from "axios";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";
import { configuredSecretId, secrets } from "./secretsManager.js";

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";

export interface SendGridMessage {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

/** Resolved lazily so tests and runtime env changes are picked up. */
async function credentials(): Promise<{ apiKey: string; from: string }> {
  const config = loadConfig();
  const secretId = configuredSecretId("SENDGRID_SECRET_ID");
  if (!secretId) return { apiKey: config.sendgridApiKey, from: config.sendgridFrom };
  const secret = await secrets.getJson(secretId);
  return {
    apiKey: secret.apiKey ?? secret.value ?? config.sendgridApiKey,
    from: secret.from ?? config.sendgridFrom,
  };
}

export async function isSendGridConfigured(): Promise<boolean> {
  return (await credentials()).apiKey.length > 0;
}

/** Loads `@sendgrid/mail` if present; returns null when it is not installed. */
async function loadOfficialClient(apiKey: string): Promise<any | null> {
  try {
    const mod: any = await import("@sendgrid/mail");
    const client = mod.default ?? mod;
    client.setApiKey(apiKey);
    return client;
  } catch {
    return null;
  }
}

/**
 * Sends a single transactional email. Never throws — callers on the indexer hot
 * path must not be interrupted by a mail provider outage.
 */
export async function sendGridSend(message: SendGridMessage): Promise<boolean> {
  const { apiKey, from } = await credentials();
  if (!apiKey) {
    logger.warn("[sendgrid] SENDGRID_API_KEY not set, skipping email dispatch");
    return false;
  }

  const sender = message.from ?? from;

  try {
    const client = await loadOfficialClient(apiKey);
    if (client) {
      await client.send({
        to: message.to,
        from: sender,
        subject: message.subject,
        html: message.html,
      });
      return true;
    }

    await axios.post(
      SENDGRID_API_URL,
      {
        personalizations: [{ to: [{ email: message.to }] }],
        from: { email: sender },
        subject: message.subject,
        content: [{ type: "text/html", value: message.html }],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      }
    );
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`[sendgrid] Failed to send "${message.subject}" to ${message.to}`, {
      error: detail,
    });
    return false;
  }
}
