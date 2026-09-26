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

## JWT session signing keys

Session JWTs are signed and verified through a key ring
(`backend/src/services/jwtKeyRing.ts`) instead of a single `JWT_SECRET`, so the
signing key can be rotated without logging every user out.

- `JWT_SECRET` / `JWT_KEY_KID` — the current signing key and the `kid` stamped
  into new tokens.
- `JWT_PREVIOUS_SECRETS` / `JWT_PREVIOUS_KEY_KIDS` — comma-separated keys that
  are still inside their grace period. Verification accepts the current key plus
  these.
- `JWT_KEY_GRACE_PERIOD_SECONDS` — how long a retired key keeps verifying tokens
  (default 7 days).
- `JWT_KEY_ROTATION_INTERVAL_SECONDS` — how old the current key may get before
  the scheduler rotates it (default 30 days).
- `JWT_KEY_ROTATION_CRON_SCHEDULE` — cron for the rotation sweep (default
  `0 4 * * *` UTC).

New tokens are always signed with the current key and carry its `kid`. During
rotation the previous key is retired, not deleted: it keeps validating for the
grace period, then the next sweep prunes it and tokens signed under it are
rejected. Legacy tokens without a `kid` are verified against every active key.

To rotate in a deployment, set the new value in `JWT_SECRET`, move the old value
into `JWT_PREVIOUS_SECRETS`, and leave it there until the grace period elapses.
Rotate `JWT_SECRET` in your secret manager first so the app picks up the new key
before old sessions issued under the previous key fall out of grace.