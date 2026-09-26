// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * KYC provider failover.
 *
 * Identity document extraction runs through the OcrProvider interface in
 * ocrService.ts. This module adds:
 *
 *   - HttpKycProvider: a secondary provider adapter that calls an external
 *     verification service and maps its response onto the same OcrResult
 *     shape, so downstream code never needs to know which provider ran.
 *
 *   - FailoverKycProvider: a circuit breaker in front of both. Any failed or
 *     timed out primary call falls back to the backup for that request. After
 *     repeated consecutive failures failover activates: the primary is skipped
 *     entirely and only probed again once per cooldown window.
 *
 * Operators are alerted when failover activates, when it is still active past
 * a configurable duration, and when the primary recovers.
 */

import axios from "axios";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";
import type { OcrExtractedFields, OcrProvider, OcrResult } from "./ocrService.js";

// ---------------------------------------------------------------------------
// Result schema reconciliation
// ---------------------------------------------------------------------------

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > 0 ? trimmed : null;
}

function firstString(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = cleanString(raw[key]);
    if (value) return value;
  }
  return null;
}

/**
 * Maps a provider response onto OcrExtractedFields. Accepts the common field
 * spellings used by verification vendors (snake_case, camelCase, split names,
 * structured addresses) and normalizes them the same way the primary provider
 * does: trimmed strings, collapsed whitespace, upper-case ID numbers, null for
 * anything missing.
 */
export function normalizeProviderFields(raw: unknown): OcrExtractedFields {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  let name = firstString(data, ["name", "fullName", "full_name"]);
  if (!name) {
    const given = firstString(data, ["firstName", "first_name", "givenNames", "given_names"]);
    const family = firstString(data, ["lastName", "last_name", "surname"]);
    name = [given, family].filter(Boolean).join(" ") || null;
  }

  const idNumber = firstString(data, [
    "idNumber",
    "id_number",
    "documentNumber",
    "document_number",
  ]);

  let address: string | null = null;
  const rawAddress = data.address ?? data.residentialAddress ?? data.residential_address;
  if (rawAddress && typeof rawAddress === "object") {
    const parts = rawAddress as Record<string, unknown>;
    address =
      [
        parts.line1,
        parts.line2,
        parts.city,
        parts.state,
        parts.postalCode ?? parts.postal_code,
        parts.country,
      ]
        .map(cleanString)
        .filter(Boolean)
        .join(", ") || null;
  } else {
    address = cleanString(rawAddress);
  }

  return {
    name,
    idNumber: idNumber ? idNumber.replace(/\s+/g, "").toUpperCase() : null,
    address,
  };
}

// ---------------------------------------------------------------------------
// Secondary provider adapter
// ---------------------------------------------------------------------------

export interface HttpKycProviderOptions {
  url: string;
  apiKey?: string | null;
  timeoutMs?: number;
}

/**
 * Sends the document to an external verification service and normalizes the
 * response. Throws on transport or HTTP errors so the failover wrapper can
 * count them against the provider.
 */
export class HttpKycProvider implements OcrProvider {
  constructor(private readonly options: HttpKycProviderOptions) {}

  async extract(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    const response = await axios.post(
      this.options.url,
      { document: buffer.toString("base64"), mimeType },
      {
        timeout: this.options.timeoutMs ?? 10_000,
        headers: this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {},
      }
    );
    const body = response.data ?? {};
    return {
      fields: normalizeProviderFields(body.fields ?? body.data ?? body),
      success: true,
      error: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Failover wrapper
// ---------------------------------------------------------------------------

export type KycFailoverAlertKind = "activated" | "persisting" | "recovered";

export interface KycFailoverAlert {
  kind: KycFailoverAlertKind;
  /** Consecutive primary failures that triggered or preceded the alert. */
  consecutiveFailures: number;
  /** When failover became active, or null once recovered. */
  activeSince: Date | null;
  lastError: string | null;
}

export interface FailoverKycProviderOptions {
  /** Consecutive primary failures before switching to the backup. */
  failureThreshold?: number;
  /** Per-request timeout applied to each provider call. */
  timeoutMs?: number;
  /** How long to stay on the backup before probing the primary again. */
  cooldownMs?: number;
  /** Raise a "persisting" alert once failover has been active this long. */
  persistAlertAfterMs?: number;
  onAlert?: (alert: KycFailoverAlert) => void | Promise<void>;
  now?: () => number;
}

class ProviderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`KYC provider timed out after ${timeoutMs}ms`);
  }
}

export class FailoverKycProvider implements OcrProvider {
  private readonly failureThreshold: number;
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly persistAlertAfterMs: number;
  private readonly now: () => number;

  private consecutiveFailures = 0;
  private failoverSince: number | null = null;
  private lastPrimaryAttempt = 0;
  private persistAlertSent = false;
  private lastError: string | null = null;

  constructor(
    private readonly primary: OcrProvider,
    private readonly backup: OcrProvider,
    private readonly options: FailoverKycProviderOptions = {}
  ) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.persistAlertAfterMs = options.persistAlertAfterMs ?? 15 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** True while requests are being served by the backup provider. */
  isFailoverActive(): boolean {
    return this.failoverSince !== null;
  }

  async extract(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    if (this.failoverSince !== null) {
      this.checkPersisting();
      if (this.now() - this.lastPrimaryAttempt < this.cooldownMs) {
        return this.runBackup(buffer, mimeType);
      }
    }

    this.lastPrimaryAttempt = this.now();
    try {
      const result = await this.call(this.primary, buffer, mimeType);
      this.recordPrimarySuccess();
      return result;
    } catch (err) {
      this.recordPrimaryFailure(err);
      return this.runBackup(buffer, mimeType);
    }
  }

  private async runBackup(buffer: Buffer, mimeType: string): Promise<OcrResult> {
    try {
      return await this.call(this.backup, buffer, mimeType);
    } catch (err) {
      const message = errorMessage(err);
      logger.error("[kyc-failover] backup provider failed", { error: message });
      return failedResult(message);
    }
  }

  /** Runs a provider with a timeout. A result with success=false counts as a failure. */
  private async call(provider: OcrProvider, buffer: Buffer, mimeType: string): Promise<OcrResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderTimeoutError(this.timeoutMs)), this.timeoutMs);
    });
    try {
      const result = await Promise.race([provider.extract(buffer, mimeType), timeout]);
      if (!result.success) {
        throw new Error(result.error ?? "KYC provider reported failure");
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordPrimarySuccess(): void {
    const wasActive = this.failoverSince !== null;
    const failures = this.consecutiveFailures;
    this.consecutiveFailures = 0;
    this.failoverSince = null;
    this.persistAlertSent = false;
    this.lastError = null;
    if (wasActive) {
      logger.info("[kyc-failover] primary provider recovered, failover deactivated");
      this.emit({ kind: "recovered", consecutiveFailures: failures, activeSince: null, lastError: null });
    }
  }

  private recordPrimaryFailure(err: unknown): void {
    this.consecutiveFailures += 1;
    this.lastError = errorMessage(err);
    logger.warn("[kyc-failover] primary provider failed", {
      error: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    });

    if (this.failoverSince === null && this.consecutiveFailures >= this.failureThreshold) {
      this.failoverSince = this.now();
      logger.error("[kyc-failover] failover activated, routing to backup provider", {
        consecutiveFailures: this.consecutiveFailures,
      });
      this.emit({
        kind: "activated",
        consecutiveFailures: this.consecutiveFailures,
        activeSince: new Date(this.failoverSince),
        lastError: this.lastError,
      });
    }
  }

  private checkPersisting(): void {
    if (this.failoverSince === null || this.persistAlertSent) return;
    if (this.now() - this.failoverSince < this.persistAlertAfterMs) return;
    this.persistAlertSent = true;
    logger.error("[kyc-failover] failover still active past threshold", {
      activeForMs: this.now() - this.failoverSince,
    });
    this.emit({
      kind: "persisting",
      consecutiveFailures: this.consecutiveFailures,
      activeSince: new Date(this.failoverSince),
      lastError: this.lastError,
    });
  }

  private emit(alert: KycFailoverAlert): void {
    if (!this.options.onAlert) return;
    Promise.resolve()
      .then(() => this.options.onAlert!(alert))
      .catch((err) =>
        logger.error("[kyc-failover] alert handler failed", { error: errorMessage(err) })
      );
  }
}

function failedResult(error: string | null): OcrResult {
  return {
    fields: { name: null, idNumber: null, address: null },
    success: false,
    error,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Alert dispatch
// ---------------------------------------------------------------------------

const ALERT_TEXT: Record<KycFailoverAlertKind, string> = {
  activated: "⚠️ *KYC provider failover activated*: primary provider is failing, verification requests are now served by the backup provider.",
  persisting: "🚨 *KYC provider failover still active*: the primary provider has not recovered within the configured threshold.",
  recovered: "✅ *KYC provider recovered*: verification requests are back on the primary provider.",
};

/** Posts a failover alert to the configured ops webhook (Slack/Discord). */
export async function sendKycFailoverAlert(alert: KycFailoverAlert): Promise<void> {
  const config = loadConfig();
  if (!config.alertWebhookUrl) return;

  const lines = [ALERT_TEXT[alert.kind]];
  if (alert.activeSince) lines.push(`Active since: ${alert.activeSince.toISOString()}`);
  if (alert.lastError) lines.push(`Last primary error: ${alert.lastError}`);
  lines.push(`Consecutive primary failures: ${alert.consecutiveFailures}`);

  try {
    await axios.post(config.alertWebhookUrl, { text: lines.join("\n") }, { timeout: 5_000 });
  } catch (err) {
    logger.error("[kyc-failover] failed to send alert", { error: errorMessage(err) });
  }
}
