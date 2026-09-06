import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import logger from "../utils/logger.js";

export interface SecretRecord {
  [key: string]: string;
}

interface CacheEntry {
  value: SecretRecord;
  expiresAt: number;
  staleUntil: number;
}

export interface SecretsManagerLike {
  send(command: GetSecretValueCommand): Promise<{
    SecretString?: string;
    SecretBinary?: Uint8Array | string;
  }>;
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_GRACE_MS = 15 * 60_000;

function parseSecret(raw: string | Uint8Array | undefined): SecretRecord {
  if (!raw) throw new Error("Secrets Manager returned an empty secret");
  const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { value: text };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Secrets Manager secret must contain a JSON object");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)])
  );
}

export class SecretProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly client: SecretsManagerLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly graceMs: number;

  constructor(
    client: SecretsManagerLike = new SecretsManagerClient({
      region: process.env.AWS_REGION || "us-east-1",
    }),
    options: { ttlMs?: number; graceMs?: number; now?: () => number } = {}
  ) {
    this.client = client;
    this.ttlMs = options.ttlMs ?? (Number(process.env.SECRETS_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS);
    this.graceMs = options.graceMs ?? (Number(process.env.SECRETS_GRACE_WINDOW_MS) || DEFAULT_GRACE_MS);
    this.now = options.now ?? Date.now;
  }

  async getJson(secretId: string, forceRefresh = false): Promise<SecretRecord> {
    const cached = this.cache.get(secretId);
    const now = this.now();
    if (!forceRefresh && cached && now < cached.expiresAt) return cached.value;

    try {
      const result = await this.client.send(new GetSecretValueCommand({ SecretId: secretId }));
      const value = parseSecret(result.SecretString ?? result.SecretBinary);
      this.cache.set(secretId, {
        value,
        expiresAt: now + this.ttlMs,
        staleUntil: now + this.ttlMs + this.graceMs,
      });
      return value;
    } catch (error) {
      if (cached && now < cached.staleUntil) {
        logger.warn("[secrets] using cached credential during refresh failure", {
          secretId,
          error: error instanceof Error ? error.message : String(error),
        });
        return cached.value;
      }
      throw error;
    }
  }

  async get(secretId: string, key: string, forceRefresh = false): Promise<string> {
    const value = (await this.getJson(secretId, forceRefresh))[key];
    if (!value) throw new Error(`Secret ${secretId} does not contain ${key}`);
    return value;
  }

  async refreshConfigured(): Promise<void> {
    const secretIds = (process.env.SECRETS_ROTATION_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    await Promise.all(secretIds.map((id) => this.getJson(id, true)));
  }
}

export const secrets = new SecretProvider();

export function configuredSecretId(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}