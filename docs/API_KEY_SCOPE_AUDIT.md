# API Key Least-Privilege Scope Audit

> Issue #772. Third-party API keys and service credentials are provisioned
> once and rarely revisited. This is a **report-only pipeline**: it never
> revokes or modifies a credential automatically. Every scope reduction below
> is a human decision, made through each provider's own console/API, with
> the integration re-verified end to end afterward.

## What the scheduled job does

- **Cadence:** weekly, Monday 11:00 UTC (`API_KEY_SCOPE_AUDIT_CRON_SCHEDULE`,
  default `0 11 * * 1`), wired in `backend/src/jobs/scheduler.ts`.
- **Signal:** for each configured integration (see the table below), the
  scopes it declares granted (`services/apiKeyScopeRegistry.ts`, overridable
  per deployment via each integration's `*_GRANTED_SCOPES` env var) are
  compared against **capability usage actually recorded** by the backend in
  the `ApiCapabilityUsage` table. A capability call site
  (`services/apiScopeUsageTracker.ts#recordApiCapabilityUsage`) increments a
  counter the moment a real outbound call to that provider succeeds.
  Implementation: `backend/src/jobs/apiKeyScopeAudit.ts`, pure comparison
  rules in `backend/src/services/apiKeyScopeAudit.ts`.
- **"Over-provisioned" definition:** a granted scope is flagged when **no**
  capability requiring it has ever recorded a successful call — either
  because our code has no capability that needs that scope at all, or
  because it has one but it's never actually been exercised.
- **Sustained-observation guard:** a scope is only flagged once its
  integration has been under observation for at least
  `API_KEY_SCOPE_AUDIT_MIN_OBSERVATION_DAYS` (default 30) days. The first
  audit run that sees a new integration just records the observation start
  time (`storage/api-scope-audit-baseline.json`,
  `API_KEY_SCOPE_AUDIT_BASELINE_PATH` override) — it never flags on day one,
  mirroring the sustained-idle logic in `docs/UNUSED_INDEX_REVIEW.md`.
- **Delivery:** email to `API_KEY_SCOPE_AUDIT_DIGEST_RECIPIENTS` (fallback:
  compliance alert email) plus an `API_KEY_SCOPE_AUDIT_REPORT` audit-log row.
  Manual trigger: `GET /api/admin/security/api-key-scopes` (admin-gated).

## Integration inventory & minimum required scope

Each integration's **minimum required scope** is derived directly from the
code, not guessed: it's exactly the set of provider-side permissions listed
in `capabilityScopes` for that integration in
`services/apiKeyScopeRegistry.ts` — i.e. the permissions our call sites
actually exercise. Reference this table when (re)provisioning any of these
credentials.

| Integration | Credential env var(s) | Minimum required scope | Common over-grant to avoid |
|---|---|---|---|
| Pinata (IPFS pinning) | `PINATA_API_KEY`, `PINATA_SECRET_API_KEY` | `pinFileToIPFS`, `pinJSONToIPFS`, `unpin` | Pinata's default key UI also enables list/query (`pinList`) access — decline it |
| Secondary IPFS (nft.storage / web3.storage) | `SECONDARY_IPFS_API_KEY` | `upload` | These providers issue single-purpose upload tokens by default; no action usually needed |
| SendGrid (transactional email) | `SENDGRID_API_KEY` | `mail_send` | A key created without "Restricted Access" defaults to Full Access, bundling marketing/stats/suppressions management |
| KYC backup verification provider | `KYC_BACKUP_PROVIDER_API_KEY` | `verify` | Some verification vendors bundle webhook/callback-URL configuration access by default |
| Postal address verification provider | `ADDRESS_VERIFICATION_API_KEY` | `verify` | Address-verification vendors commonly bundle bulk/batch-processing and usage-analytics access by default |
| AWS S3 (database backups) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject` | Bucket policies scoped "for backups" commonly also grant `s3:PutBucketPolicy` / `s3:DeleteBucket` |
| Google Cloud Storage (database backups) | `GCS_KEY_FILE` | `storage.objects.create/get/list/delete` | The "Storage Admin" predefined role is a common provisioning shortcut that also grants bucket delete / IAM-policy control |
| Arweave (Irys bundler) | `IRYS_PRIVATE_KEY` | n/a — wallet private key | Not scope-auditable: a wallet key is inherently all-or-nothing. Inventoried only. |
| Ops alert webhook (Slack/Discord) | `ALERT_WEBHOOK_URL` | n/a — incoming webhook | Not scope-auditable: an incoming webhook URL can only ever post a message. Inventoried only. |

Note: this backend has no dedicated payment-gateway credential today — the
Stellar Horizon / Soroban RPC endpoints it calls are public, unauthenticated
infrastructure and are out of scope for this audit.

## Human review process (required before reducing any scope)

1. **Triage the report.** For each flagged `(integration, scope)` pair,
   confirm from the "Minimum required scope" column above that the
   application genuinely has no use for it — don't reduce a scope backing a
   capability that's simply rare (e.g. a quarterly restore), only one with
   zero code path to ever call it.
2. **Check for planned near-term use.** Search open feature branches/issues
   for the integration name before reducing scope — a capability with a
   merged-but-unreleased call site will show as "unused" until it ships.
3. **Reduce scope at the provider**, not in this repo: regenerate or edit
   the key/service-account/IAM-policy via the provider's own console or API
   to grant only the "Minimum required scope" column's permissions.
4. **Update the deployment's granted-scope override** (the relevant
   `*_GRANTED_SCOPES` env var) to match the new, reduced grant, so the next
   audit run reflects reality instead of the old default assumption.
5. **Verify end to end.** Exercise every capability in that integration's
   `capabilityScopes` (e.g. for Pinata: pin a file, pin JSON, unpin) in a
   staging environment before rolling the reduced-scope credential to
   production.
6. **Two-person rule.** A security or backend owner must approve any scope
   reduction PR/change, same as an index-removal migration.

## What this pipeline will never do

- Automatically revoke, rotate, or modify any credential.
- Flag a scope on an integration younger than the minimum observation
  window.
- Treat a wallet private key or a bare incoming webhook URL as
  scope-reducible — both are inventoried but excluded from comparison.
