import crypto from "crypto";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

const config = loadConfig();

/**
 * Sends a signed webhook payload to a specified partner URL.
 * Signs the payload using HMAC-SHA256 with the configured secret.
 */
export async function sendWebhook(url: string, payload: any): Promise<boolean> {
  const secret = config.webhookSecret;
  const timestamp = Date.now().toString();
  const bodyString = JSON.stringify(payload);

  // Sign payload using HMAC SHA-256: hmac(secret, timestamp + '.' + body)
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${timestamp}.${bodyString}`);
  const signature = hmac.digest("hex");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature": signature,
      },
      body: bodyString,
    });

    if (!response.ok) {
      logger.error(`[WebhookService] HTTP Error from ${url}`, { status: response.status });
      return false;
    }

    return true;
  } catch (error) {
    logger.error(`[WebhookService] Fetch failure sending webhook to ${url}`, { error });
    return false;
  }
}
