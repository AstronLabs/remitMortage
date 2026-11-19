# Client Bundle Secret Scan

Anything bundled into the frontend is public. A misconfigured environment
variable can ship a private key or token to every visitor, so CI builds the
frontend and scans the result (`.github/workflows/client-bundle-secret-scan.yml`,
`scripts/client-bundle-secret-scan.mjs`).

## What it checks

1. **Bundle contents.** Every file under `frontend/.next/static` — JavaScript,
   CSS, HTML, JSON — plus the *application* sources embedded in the browser
   source maps (`sourcesContent`). Rules cover Stellar secret seeds (checksum
   validated, so public keys `G…` and contract ids `C…` never match), AWS keys,
   GitHub / Slack / Stripe / SendGrid / Anthropic / OpenAI / npm / Sentry
   tokens, PEM private keys, JWTs, URLs with embedded credentials, and
   high-entropy values assigned to secret-named keys (`client_secret: "…"`).
   Dependency sources in source maps are skipped by default
   (`--include-dependency-sources` opts in).
2. **Server secret values.** The *values* of server-only, secret-named
   environment variables (`*SECRET*`, `*TOKEN*`, `*KEY`, `*PASSWORD*`, …; at
   least 12 characters) must not appear anywhere in the bundle. CI sets a
   per-run canary secret so this check is always exercised.
3. **Public prefix.** `next.config` `env:` keys and `process.env.X` reads in
   `"use client"` files must be `NEXT_PUBLIC_*` (plus `NODE_ENV`,
   `NEXT_RUNTIME`, `NEXT_PHASE`), and a `NEXT_PUBLIC_*` name that looks like a
   secret (`NEXT_PUBLIC_ADMIN_SECRET`) is rejected. `NEXT_PUBLIC_VAPID_PUBLIC_KEY`
   style names are fine.

A match outside the allowlist fails the build (exit 2). The report shows the
rule, location (`chunks/x.js.map!webpack://app/src/…:12` for source-map
sources), a redacted preview and the match's SHA-256 — **the full value is
never printed**.

## Allowlist

`devops/client-bundle-secret-allowlist.json` holds reviewed exceptions, each
with a mandatory `reason`:

```json
{
  "hashes": [{ "sha256": "<hash from the report>", "rule": "google-api-key", "reason": "Browser-restricted Maps key, referrer-locked" }],
  "values": [{ "value": "AIza…", "reason": "Public identifier" }],
  "files":  [{ "path": "chunks/vendor-*.js", "rule": "jwt", "reason": "Library test vector" }],
  "env":    ["SOME_INLINED_VAR"]
}
```

Prefer `hashes` so the file never stores a secret. `rule` narrows an entry to
one detection rule. A real secret is **not** allowlisted: remove it from client
code and rotate it.

## Running locally

```bash
cd frontend && CLIENT_BUNDLE_SOURCEMAPS=true npm run build && cd ..
node scripts/client-bundle-secret-scan.mjs                # frontend/.next/static
node scripts/client-bundle-secret-scan.mjs --env-file frontend/.env.production
node --test scripts/client-bundle-secret-scan.test.mjs    # planted-secret tests
```

`CLIENT_BUNDLE_SOURCEMAPS=true` makes `next.config.ts` emit browser source
maps; it is only set for this scan and never in production builds.

## Tests

`scripts/client-bundle-secret-scan.test.mjs` plants fake secrets (assembled at
runtime so no secret-shaped literal sits in the repo) in a temporary bundle and
source map, and asserts that each known format fails the scan, that a clean
bundle and allowlisted public identifiers pass, that leaked server env values
are caught, and that the CLI exit codes and redaction hold.
