# Anonymized Staging/Dev Seed Pipeline

Lets developers and QA work against realistic, production-shaped data in
staging and dev without ever exposing real borrower PII.

## What it does

`backend/scripts/anonymize-staging-seed.ts` reads a production database
snapshot (ideally a read-only replica, never the primary) and writes an
irreversibly anonymized copy into a lower-environment database:

- **Referential integrity is preserved.** Primary keys and foreign keys are
  copied unchanged; tables are copied parent-before-child (see `MODEL_ORDER`
  in the script). Only PII *payload* columns (wallet/Stellar addresses,
  emails, phone numbers, tax IDs, IP addresses, document names, DIDs,
  session/API secrets, webhook URLs/secrets, ...) are replaced.
- **Realistic distributions are preserved.** Anonymized values keep the
  shape of the original (a Stellar address still looks like a Stellar
  address; `monthlyIncome` is jittered ±8% rather than replaced, so
  aggregate stats stay representative).
- **It's irreversible.** Every PII field is replaced with the output of an
  HMAC-SHA256 keyed hash. The key (`salt`) is generated fresh in memory for
  each run via `crypto.randomBytes` and is never written to disk, logged, or
  returned — once the process exits, there is no way (for anyone, including
  whoever ran the job) to map an anonymized value back to the original.
  Within a single run, the same source value always maps to the same output,
  which keeps unique constraints (e.g. `stellarAddress`) satisfied.

## Running it

```bash
cd backend
SOURCE_DATABASE_URL=postgres://readonly-user@prod-replica/db \
TARGET_DATABASE_URL=postgres://staging-user@staging-db/db \
ANONYMIZE_TARGET_ENV=staging \
  npm run anonymize:staging-seed
```

Each run clears the target's tables first, so it's idempotent — safe to run
repeatedly on a schedule.

## Cadence

`devops/k8s/anonymized-staging-seed-cronjob.yaml` runs the pipeline weekly
(Sunday 03:00 UTC) inside the **staging cluster only**. See
[devops/k8s/README.md](../devops/k8s/README.md) for deployment details.

## Safeguards against running against production

This pipeline's entire purpose is to move data out of production, so it
fails closed at every layer rather than offering an override:

1. **Explicit opt-in target.** `ANONYMIZE_TARGET_ENV` must literally be one
   of `staging`, `dev`, `development`, or `test`. There is no default — an
   unset or misspelled value refuses to run rather than silently proceeding.
2. **`NODE_ENV=production` refuses outright.** The pipeline must be invoked
   from a CI/ops job, never from inside a production deployment's own
   process.
3. **Source/target identity check.** If `TARGET_DATABASE_URL` equals
   `SOURCE_DATABASE_URL`, the run is refused — the pipeline is destructive to
   its target (it clears tables before reseeding), so source and target must
   always be distinct databases.
4. **Connection-string pattern check.** `TARGET_DATABASE_URL` is rejected if
   it contains `prod`, `production`, `primary`, or `master`, as defense in
   depth against a copy-pasted production URL.
5. **Deployment topology.** The CronJob is defined to run only in the
   staging cluster/namespace; it authenticates to production solely via a
   read-only replica credential (`production-readonly-secrets`), and its
   write target is always the staging DB secret in that same namespace.

See `assertSafeToRun()` in `backend/scripts/anonymize-staging-seed.ts` for
the implementation.

## Fail-closed PII leak gate

Every batch is verified **after** anonymization and **before** any write to
staging (`assertNoPiiLeak` / `scanBatchForPiiLeak`):

1. **Verbatim-survival check** — each field covered by `FIELD_ANONYMIZERS`
   must differ from its source value (nulls/empties exempt). A new column
   added without a rule, or a broken anonymizer, trips this.
2. **Known-PII pattern check** — any value in the anonymized row matching a
   real-PII shape fails the batch: SSN `XXX-XX-XXXX`, non-`@example-anon.invalid`
   emails, non-`example-anon.invalid` URLs, non-`203.0.113.x` IPv4, etc.

Any hit throws and aborts the refresh **without loading that batch** —
staging is left empty rather than populated with leaked PII (fail closed).
Investigate, add/fix the anonymizer rule, and re-run.

## Anonymization rules per table/field

| Table (Prisma model) | Field | Rule |
|---|---|---|
| applicant | stellarAddress | Synthetic `G…` address (HMAC, per-run salt) |
| applicant | taxId | Opaque `tax-<hex>` token |
| applicant | monthlyIncome | Jittered ±8%, precision preserved |
| borrower | stellarAddress | Synthetic `G…` address |
| workspaceMember | walletAddress | Synthetic `G…` address |
| workspaceInvitation | inviteeAddress / invitedBy | Synthetic `G…` addresses |
| loanApplication | assignedReviewerEmail | `user-<hex>@example-anon.invalid` |
| kycDocument | documentId | Opaque `doc-<hex>` token |
| kycDocument | originalName | `document-<hex>.<ext>` |
| notificationPreference | email / phone / webhookUrl | Synthetic email / `+1555…` / `example-anon.invalid` URL |
| borrowerCredential | did / didHash / issuer / challenge | `did:anon:…` / hex / opaque tokens |
| auditLog | actorAddress / ipAddress | Synthetic address / `203.0.113.x` (TEST-NET-3) |
| sessionToken | walletAddress / tokenHash | Synthetic address / hex |
| apiKey | key / name | Random hex / `key-<hex>` label |
| webhookSubscription | url / secret / previousSecret / ownerAddress | Synthetic URL / hex / synthetic address |
| webhookDLQ | url | Synthetic URL |
| notification | recipient | Synthetic email (EMAIL) or address |
| inAppNotification | walletAddress | Synthetic address |
| dataDeletionRequest | walletAddress | Synthetic address |

When the Prisma schema gains a PII-bearing column, add its rule to
`FIELD_ANONYMIZERS` in the same change — the leak gate will otherwise fail
the refresh until it is covered.
