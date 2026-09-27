// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Inventory of third-party credentials the backend holds, and the minimum
 * scope each one actually needs (issue #772).
 *
 * `capabilityScopes` is the source of truth for "minimum required scope": it
 * is exactly the set of provider-side permissions our code has a call site
 * for. Anything a credential is granted beyond that set is, by definition,
 * unused by this application and a candidate for scope reduction — see
 * `docs/API_KEY_SCOPE_AUDIT.md`.
 *
 * `defaultGrantedScopes` documents the scope bundle each provider's default
 * key-generation flow tends to hand out (a real, common over-provisioning
 * risk even before an operator confirms the actual grant). Override per
 * deployment via `grantedScopesEnvVar` once the real granted scope is known —
 * that override should be updated any time a key is re-provisioned.
 */

export interface ApiIntegrationDefinition {
  /** Stable id — matches `ApiCapabilityUsage.integration` and report keys. */
  integration: string;
  /** Human-readable name for reports and docs. */
  displayName: string;
  /** Credential env var(s) this integration reads (never logged or exposed). */
  credentialEnvVars: string[];
  /** Every capability our code can exercise, mapped to the scope it requires. */
  capabilityScopes: Record<string, string>;
  /** Env var holding a comma-separated override of the credential's actual granted scopes. */
  grantedScopesEnvVar: string;
  /** Assumed granted scopes when the override env var is unset. */
  defaultGrantedScopes: string[];
  /** Whether this integration is enabled in the current environment. */
  isConfigured: (env: NodeJS.ProcessEnv) => boolean;
  /**
   * False for credentials with no meaningful scope model to audit (e.g. a
   * bare incoming webhook URL that can only ever do one thing). Still
   * inventoried in the doc; excluded from the scheduled scope comparison.
   * Defaults to true.
   */
  auditable?: boolean;
}

export const API_INTEGRATIONS: ApiIntegrationDefinition[] = [
  {
    integration: "pinata",
    displayName: "Pinata (IPFS pinning)",
    credentialEnvVars: ["PINATA_API_KEY", "PINATA_SECRET_API_KEY"],
    capabilityScopes: {
      pin_file: "pinFileToIPFS",
      pin_json: "pinJSONToIPFS",
      unpin: "unpin",
    },
    grantedScopesEnvVar: "PINATA_GRANTED_SCOPES",
    // Pinata's default key-generation UI enables the full "pinning" bundle,
    // including list/query access our code never calls.
    defaultGrantedScopes: ["pinFileToIPFS", "pinJSONToIPFS", "unpin", "pinList"],
    isConfigured: (env) => Boolean(env.PINATA_API_KEY && env.PINATA_SECRET_API_KEY),
  },
  {
    integration: "ipfs_secondary",
    displayName: "Secondary IPFS pinning (nft.storage / web3.storage)",
    credentialEnvVars: ["SECONDARY_IPFS_API_KEY"],
    capabilityScopes: {
      pin_file: "upload",
    },
    grantedScopesEnvVar: "IPFS_SECONDARY_GRANTED_SCOPES",
    defaultGrantedScopes: ["upload"],
    isConfigured: (env) => Boolean(env.SECONDARY_IPFS_PROVIDER && env.SECONDARY_IPFS_API_KEY),
  },
  {
    integration: "sendgrid",
    displayName: "SendGrid (transactional email)",
    credentialEnvVars: ["SENDGRID_API_KEY"],
    capabilityScopes: {
      send_mail: "mail_send",
    },
    grantedScopesEnvVar: "SENDGRID_GRANTED_SCOPES",
    // A SendGrid key created without "Restricted Access" scoping defaults to
    // Full Access, which bundles marketing/stats/suppressions management
    // that a transactional-only integration never touches.
    defaultGrantedScopes: ["mail_send", "marketing_campaigns", "stats_read", "suppressions_manage"],
    isConfigured: (env) => Boolean(env.SENDGRID_API_KEY),
  },
  {
    integration: "kyc_backup",
    displayName: "KYC backup verification provider",
    credentialEnvVars: ["KYC_BACKUP_PROVIDER_API_KEY"],
    capabilityScopes: {
      verify: "verify",
    },
    grantedScopesEnvVar: "KYC_BACKUP_GRANTED_SCOPES",
    // Many verification vendors bundle webhook/callback-URL configuration
    // access alongside the verify endpoint by default.
    defaultGrantedScopes: ["verify", "webhook_management"],
    isConfigured: (env) => Boolean(env.KYC_BACKUP_PROVIDER_URL),
  },
  {
    integration: "aws_s3_backup",
    displayName: "AWS S3 (database backups)",
    credentialEnvVars: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
    capabilityScopes: {
      put_object: "s3:PutObject",
      get_object: "s3:GetObject",
      list_objects: "s3:ListBucket",
      delete_object: "s3:DeleteObject",
      // CopyObject is implemented by S3 as a Get on the source plus a Put on
      // the destination — there is no separate IAM action for it.
      copy_object: "s3:PutObject",
    },
    grantedScopesEnvVar: "AWS_S3_BACKUP_GRANTED_SCOPES",
    // A bucket policy scoped "for backups" commonly over-grants
    // bucket-administration actions this integration never calls.
    defaultGrantedScopes: [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:DeleteObject",
      "s3:PutBucketPolicy",
      "s3:DeleteBucket",
    ],
    isConfigured: (env) =>
      Boolean(
        env.AWS_ACCESS_KEY_ID &&
          env.AWS_SECRET_ACCESS_KEY &&
          (env.BACKUP_PROVIDER || "aws") === "aws"
      ),
  },
  {
    integration: "gcs_backup",
    displayName: "Google Cloud Storage (database backups)",
    credentialEnvVars: ["GCS_KEY_FILE"],
    capabilityScopes: {
      put_object: "storage.objects.create",
      get_object: "storage.objects.get",
      list_objects: "storage.objects.list",
      delete_object: "storage.objects.delete",
      copy_object: "storage.objects.create",
    },
    grantedScopesEnvVar: "GCS_BACKUP_GRANTED_SCOPES",
    // The "Storage Admin" predefined role is a common shortcut for
    // provisioning a backup service account; it grants bucket
    // create/delete/IAM-policy control this integration never uses.
    defaultGrantedScopes: [
      "storage.objects.create",
      "storage.objects.get",
      "storage.objects.list",
      "storage.objects.delete",
      "storage.buckets.delete",
      "storage.buckets.setIamPolicy",
    ],
    isConfigured: (env) => Boolean(env.GCS_KEY_FILE && env.BACKUP_PROVIDER === "gcs"),
  },
  {
    integration: "arweave",
    displayName: "Arweave via Irys bundler",
    credentialEnvVars: ["IRYS_PRIVATE_KEY"],
    capabilityScopes: {
      upload: "upload",
    },
    grantedScopesEnvVar: "ARWEAVE_GRANTED_SCOPES",
    defaultGrantedScopes: ["upload"],
    isConfigured: (env) => Boolean(env.IRYS_PRIVATE_KEY),
    // A wallet private key, not a scoped API key — it is inherently
    // all-or-nothing, so "scope reduction" does not apply. Inventoried for
    // completeness only.
    auditable: false,
  },
  {
    integration: "ops_alert_webhook",
    displayName: "Ops alert webhook (Slack/Discord incoming webhook)",
    credentialEnvVars: ["ALERT_WEBHOOK_URL"],
    capabilityScopes: {
      post_message: "post_message",
    },
    grantedScopesEnvVar: "ALERT_WEBHOOK_GRANTED_SCOPES",
    defaultGrantedScopes: ["post_message"],
    isConfigured: (env) => Boolean(env.ALERT_WEBHOOK_URL),
    // An incoming webhook URL can only ever post a message — there is no
    // broader scope it could be over-provisioned with.
    auditable: false,
  },
];
