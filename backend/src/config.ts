/** Environment configuration with validation. */

export type StellarNetwork = "testnet" | "mainnet" | "futurenet" | "standalone";

const NETWORK_PASSPHRASE_DEFAULTS: Record<StellarNetwork, string> = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
  futurenet: "Test SDF Future Network ; October 2022",
  standalone: "Standalone Network ; February 2017",
};

export interface Config {
  port: number;
  stellarNetwork: StellarNetwork;
  networkPassphrase: string;
  horizonUrl: string;
  sorobanRpcUrl: string;
  sorobanRpcUrls: string[];
  escrowContractId: string;
  lendingPoolContractId: string;
  usdcTokenId: string;
  pinataApiKey: string;
  pinataSecretApiKey: string;
  /** Secondary IPFS provider API key for redundancy (e.g., NFT.storage or Web3.storage). */
  secondaryIpfsProvider: "nft.storage" | "web3.storage" | null;
  /** Secondary IPFS provider API key. */
  secondaryIpfsApiKey: string | null;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  /** SendGrid API key used by the event-driven email alerting service. */
  sendgridApiKey: string;
  /** Verified sender address for SendGrid alert emails. */
  sendgridFrom: string;
  /** Map of on-chain borrower address -> alert recipient email address. */
  alertRecipients: Record<string, string>;
  /** Fallback recipient used when a borrower address has no mapped email. */
  alertDefaultRecipient: string;
  webhookSecret: string;
  /** Recipient notified when a webhook signing key auto-rotates. Rotation still runs if unset. */
  webhookRotationNotifyEmail: string;
  allowedOrigins: string[];
  adminApiKey: string;
  redisUrl: string | null;
  redisClusterEnabled: boolean;
  redisClusterNodes: string[];
  remittanceCacheTtl: number;
  /** KMS-managed Key Encryption Keys, keyed by rotation version (e.g. "v1", "v2"). */
  kmsKeyVersions: Record<string, string>;
  /** The key version used to wrap newly-generated data keys. Existing files keep unwrapping with the version they were sealed under. */
  kmsActiveKeyVersion: string;
  /** Signing secret for temporary IAM-style KYC document decryption tokens. */
  kycOperatorSecret: string;
  /** Secret used to sign output verification proofs. */
  backendSigningSecret: string;
  /** Private key for the Irys bundler node to pay for Arweave uploads. */
  irysPrivateKey: string;
  /** Network token used for Irys payments (e.g. "matic", "ethereum"). */
  irysNetworkToken: string;
  /** Lifetime (seconds) of a temporary KYC decryption access token. */
  kycAccessTokenTtlSeconds: number;
  /** Maximum base fee for Stellar transactions (in stroops). */
  maxStellarBaseFee: number;
  /** Maximum base fee for EVM transactions (in wei). */
  maxEvmBaseFee: number;
  /** Maximum base fee for Solana transactions (in lamports). */
  maxSolanaBaseFee: number;
  /**
   * Incoming webhook URL (Slack or Discord) used to alert operators when a
   * Soroban RPC node becomes unhealthy or recovers. Null disables alerting.
   */
  alertWebhookUrl: string | null;
  /**
   * Maximum number of ledgers a node may lag behind the best-observed node
   * before it is flagged as suffering a sync delay.
   */
  rpcSyncLagThreshold: number;
  /**
   * Minimum retained ledger window (latest − oldest) a node must expose before
   * it is flagged for insufficient ledger history. 0 disables the check.
   */
  rpcMinLedgerRetention: number;
  /** Interval (ms) between background Soroban RPC health probes. */
  rpcHealthCheckIntervalMs: number;
  /** Per-status SLA window in hours for loan applications. */
  applicationSlaHours: Record<string, number>;
  /** Fallback recipient email for ops SLA alerts. */
  opsFallbackAlertEmail: string;
  /** Incoming Slack webhook URL for ops SLA alerts. */
  opsSlackWebhookUrl: string | null;
  /** Number of days expired session/refresh tokens are retained before being purged. */
  sessionTokenRetentionDays: number;
  /** Compliance-reviewed retention window for soft-deleted borrower profiles. */
  borrowerRecordRetentionDays: number;
  /** Compliance-reviewed retention window for soft-deleted loan applications. */
  loanRecordRetentionDays: number;
  /** Days of inactivity before a Draft loan application is flagged as stale and the applicant notified. */
  draftStaleThresholdDays: number;
  /** Days after a stale notice before an unresumed Draft is soft-deleted (expired). */
  draftStaleExpiryGraceDays: number;
  /** When true, registration requires a valid unused invite code (soft-launch gating). */
  inviteCodeRequired: boolean;
}

/** Parses APPLICATION_SLA_HOURS (a JSON map of status -> SLA hours). */
function parseApplicationSlaHours(raw: string | undefined): Record<string, number> {
  const defaults: Record<string, number> = {
    Pending: 48,
    Disbursing: 24,
  };
  if (!raw) return defaults;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ...defaults, ...parsed };
    }
  } catch {
    // fallback
  }
  return defaults;
}

/** Parses KMS_KEY_VERSIONS (a JSON map of version -> 64-hex-char key) with a dev-safe fallback. */
function parseKmsKeyVersions(raw: string | undefined): Record<string, string> {
  const devDefault = { v1: "0".repeat(64) };
  if (!raw) return devDefault;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // fall through to the dev default below
  }
  return devDefault;
}

/** Parses ALERT_RECIPIENTS (a JSON map of borrower address -> email address). */
function parseAlertRecipients(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // malformed input falls back to an empty map
  }
  return {};
}

export function loadConfig(): Config {
  return {
    port: parseInt(process.env.PORT || "4000", 10),
    stellarNetwork: (process.env.STELLAR_NETWORK as StellarNetwork) || "testnet",
    networkPassphrase:
      process.env.STELLAR_NETWORK_PASSPHRASE ||
      NETWORK_PASSPHRASE_DEFAULTS[
        (process.env.STELLAR_NETWORK as StellarNetwork) || "testnet"
      ],
    horizonUrl:
      process.env.HORIZON_URL || "https://horizon-testnet.stellar.org",
    sorobanRpcUrl:
      process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
    sorobanRpcUrls: process.env.SOROBAN_RPC_URLS
      ? process.env.SOROBAN_RPC_URLS.split(",").map((url) => url.trim())
      : [process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org"],
    escrowContractId: process.env.ESCROW_CONTRACT_ID || "",
    lendingPoolContractId: process.env.LENDING_POOL_CONTRACT_ID || "",
    usdcTokenId: process.env.USDC_TOKEN_ID || "",
    pinataApiKey: process.env.PINATA_API_KEY || "",
    pinataSecretApiKey: process.env.PINATA_SECRET_API_KEY || "",
    secondaryIpfsProvider: (process.env.SECONDARY_IPFS_PROVIDER as "nft.storage" | "web3.storage") || null,
    secondaryIpfsApiKey: process.env.SECONDARY_IPFS_API_KEY || null,
    smtpHost: process.env.SMTP_HOST || "localhost",
    smtpPort: parseInt(process.env.SMTP_PORT || "587", 10),
    smtpUser: process.env.SMTP_USER || "",
    smtpPass: process.env.SMTP_PASS || "",
    smtpFrom: process.env.SMTP_FROM || "no-reply@remitmortgage.com",
    sendgridApiKey: process.env.SENDGRID_API_KEY || "",
    sendgridFrom:
      process.env.SENDGRID_FROM ||
      process.env.SMTP_FROM ||
      "no-reply@remitmortgage.com",
    alertRecipients: parseAlertRecipients(process.env.ALERT_RECIPIENTS),
    alertDefaultRecipient: process.env.ALERT_DEFAULT_RECIPIENT || "",
    webhookSecret: process.env.WEBHOOK_SECRET || "default_signing_secret_key",
    webhookRotationNotifyEmail: process.env.WEBHOOK_ROTATION_NOTIFY_EMAIL || "",
    allowedOrigins: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim())
      : ["http://localhost:3000", "http://localhost:4000"],
    adminApiKey: process.env.ADMIN_API_KEY || "default_admin_api_key",
    redisUrl: process.env.REDIS_URL || null,
    redisClusterEnabled: process.env.REDIS_CLUSTER_ENABLED === "true",
    redisClusterNodes: process.env.REDIS_CLUSTER_NODES
      ? process.env.REDIS_CLUSTER_NODES.split(",").map((n) => n.trim())
      : [],
    remittanceCacheTtl: parseInt(process.env.REMITTANCE_CACHE_TTL || "300", 10),
    kmsKeyVersions: parseKmsKeyVersions(process.env.KMS_KEY_VERSIONS),
    kmsActiveKeyVersion: process.env.KMS_ACTIVE_KEY_VERSION || "v1",
    kycOperatorSecret: process.env.KYC_OPERATOR_SECRET || "default_kyc_operator_secret",
    backendSigningSecret: process.env.BACKEND_SIGNING_SECRET || "default_backend_signing_secret",
    irysPrivateKey: process.env.IRYS_PRIVATE_KEY || "",
    irysNetworkToken: process.env.IRYS_NETWORK_TOKEN || "matic",
    kycAccessTokenTtlSeconds: parseInt(process.env.KYC_ACCESS_TOKEN_TTL || "300", 10),
    maxStellarBaseFee: parseInt(process.env.MAX_STELLAR_BASE_FEE || "100000", 10),
    maxEvmBaseFee: parseInt(process.env.MAX_EVM_BASE_FEE || "100000000000", 10),
    maxSolanaBaseFee: parseInt(process.env.MAX_SOLANA_BASE_FEE || "10000", 10),
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || null,
    rpcSyncLagThreshold: parseInt(process.env.RPC_SYNC_LAG_THRESHOLD || "100", 10),
    rpcMinLedgerRetention: parseInt(process.env.RPC_MIN_LEDGER_RETENTION || "0", 10),
    rpcHealthCheckIntervalMs: parseInt(
      process.env.RPC_HEALTH_CHECK_INTERVAL_MS || "60000",
      10
    ),
    applicationSlaHours: parseApplicationSlaHours(process.env.APPLICATION_SLA_HOURS),
    opsFallbackAlertEmail:
      process.env.OPS_FALLBACK_ALERT_EMAIL ||
      process.env.ALERT_DEFAULT_RECIPIENT ||
      "ops@remitmortgage.com",
    opsSlackWebhookUrl:
      process.env.OPS_SLACK_WEBHOOK_URL ||
      process.env.SLACK_WEBHOOK_URL ||
      process.env.ALERT_WEBHOOK_URL ||
      null,
    sessionTokenRetentionDays: parseInt(
      process.env.SESSION_TOKEN_RETENTION_DAYS ||
        process.env.RETENTION_DAYS ||
        "7",
      10
    ),
    borrowerRecordRetentionDays: parseInt(
      process.env.BORROWER_RECORD_RETENTION_DAYS || "2555",
      10
    ),
    loanRecordRetentionDays: parseInt(
      process.env.LOAN_RECORD_RETENTION_DAYS || "2555",
      10
    ),
    draftStaleThresholdDays: parseInt(
      process.env.DRAFT_STALE_THRESHOLD_DAYS || "90",
      10
    ),
    draftStaleExpiryGraceDays: parseInt(
      process.env.DRAFT_STALE_EXPIRY_GRACE_DAYS || "7",
      10
    ),
    inviteCodeRequired: process.env.INVITE_CODE_REQUIRED === "true",
  };
}
