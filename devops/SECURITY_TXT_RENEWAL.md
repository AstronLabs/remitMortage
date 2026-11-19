# security.txt Renewal Runbook

## Overview

[`/.well-known/security.txt`](../frontend/public/.well-known/security.txt)
(RFC 9116) is how security researchers find our disclosure policy. An
expired `Expires` field is treated the same as a broken contact channel:
researchers' tooling flags it as stale and some will not bother reporting
to an untrustworthy-looking policy.

- **Monitor:** `scripts/check-security-txt-expiry.sh`
- **Schedule:** `.github/workflows/security-txt-expiry.yml` (daily at
  07:00 UTC, plus `workflow_dispatch`)
- **Warning window:** 30 days (`SECURITYTXT_WARN_DAYS`, overridable per run
  or via the `SECURITYTXT_WARN_DAYS` repo variable)
- **Alert channel:** email to `ALERT_EMAIL_TO` once the live
  `security.txt` is within the warning window, already expired, or
  unreachable/malformed

## Renewal procedure

1. Edit `frontend/public/.well-known/security.txt`: bump `Expires` to a new
   date-time at least a year out, in RFC 3339 format
   (`YYYY-MM-DDTHH:MM:SS.sssZ`).
2. While you're there, confirm the rest of the file still points to a live
   target:
   - `Contact:` addresses/URLs still monitored
   - `Encryption:` PGP key still current (see key rotation below)
   - `Policy:` still resolves to the current `SECURITY.md`
3. Re-read `SECURITY.md`'s response targets and scope — renewal is also the
   trigger to confirm they're still accurate, not just the date.
4. Open a PR. `.github/workflows/security-txt-expiry.yml`'s `pull_request`
   guard runs `--check-config` against the changed file (parses it and
   confirms `Expires` is valid and in the future) before merge.
5. Once merged and deployed, the next scheduled run picks up the live file
   automatically — no separate step needed.

## PGP key rotation

The published key
([`frontend/public/.well-known/pgp-key.txt`](../frontend/public/.well-known/pgp-key.txt),
fingerprint `DF8A 873B 671E F26C 71D7  7D2E C05E BDBB AF26 16DA`) was
generated as a bootstrap placeholder and its private key is **not**
custodied in any production secrets system. Before relying on it to
receive a real sensitive report:

1. Generate a replacement key for `security@remitmortgage.com` with the
   actual security owner's tooling (hardware token or a properly-custodied
   secrets manager entry for the private key — never commit a private key
   to this repository).
2. Publish the new public key at the same path
   (`frontend/public/.well-known/pgp-key.txt`), update the fingerprint in
   `SECURITY.md`, and keep the old key available (clearly marked
   superseded) for a short overlap window so in-flight encrypted reports
   using the old key can still be decrypted.
3. Update this section with the new fingerprint and generation date.

## Reading an alert

The `security-txt-expiry-report` artifact has one line summary plus a
tab-separated detail row:

```
source   days_left   state   expires   error
```

- `state=OK` — outside the window, no action.
- `state=EXPIRING` — renew before the date above using the procedure above.
- `state=EXPIRED` — renew immediately; treat as past due.
- `state=UNREACHABLE` / `MALFORMED` — the live file failed to load or
  didn't parse (missing `Expires:` field, bad date format, wrong
  content-type). Check the deployment first; this usually means a build or
  routing regression, not an actual policy problem.
