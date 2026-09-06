# Secrets Rotation

The backend supports AWS Secrets Manager for the database URL and third-party
API credentials. Configure `DATABASE_SECRET_ID`, `SENDGRID_SECRET_ID`, and
`SECRETS_ROTATION_IDS` with secret ARNs or names. Secrets may be JSON objects
(`{"databaseUrl":"..."}` or `{"apiKey":"..."}`) or raw values.

The refresh job runs every five minutes by default. `SECRETS_CACHE_TTL_MS`
controls how long a value is reused; `SECRETS_GRACE_WINDOW_MS` controls how long
the previous value may be used after a failed refresh. Set both according to the
provider's rotation window. A refresh failure after the grace window is fatal to
the affected operation instead of silently using an expired credential.

For database rotation, the job fetches the new URL, creates a new Prisma pool,
executes `SELECT 1`, then swaps the pool. The previous pool drains for
`DB_ROTATION_DRAIN_MS`, so active requests finish while new requests use the new
credential. External rotation Lambdas must keep the old database credential
valid until this drain and grace window have elapsed, then invalidate it.

Terraform grants the App Runner instance role read access to the configured
secret ARNs. Set `secrets_rotation_lambda_arn` to enable scheduled
`aws_secretsmanager_secret_rotation` resources; the Lambda must implement the
Secrets Manager four-step contract: `createSecret`, `setSecret`, `testSecret`,
and `finishSecret`. The `finishSecret` step must promote the new version only
after `testSecret` succeeds and revoke the old credential after the grace
window.