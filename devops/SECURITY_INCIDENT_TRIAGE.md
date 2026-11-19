# Security Report Triage Workflow (internal)

Internal companion to the public policy in [`SECURITY.md`](../SECURITY.md).
This document covers who owns an incoming report and what happens to it
between "received" and "closed."

## Owner

- **Primary:** Security Team (`security@remitmortgage.com` — monitored by
  the on-call security engineer on the rotation defined in the paging
  tool; update this doc with the real rotation link when one exists).
- **Escalation:** Engineering Lead, looped in automatically for anything
  triaged Critical or High (see below).
- **Decision authority:** The Security Team owner has final say on
  severity, remediation priority, and disclosure timing, consulting
  Engineering Lead for anything touching contracts holding live funds.

Every report must have a single named owner within one business day of
acknowledgment — "the team" owning a report is how reports go stale.

## Intake

Reports arrive via one of the two channels in `SECURITY.md`:
1. `security@remitmortgage.com` (PGP-capable)
2. A private GitHub Security Advisory on this repository

Both land with the on-call security engineer. On intake:

1. **Acknowledge** the reporter within 2 business days (target in
   `SECURITY.md`). A short "received, triaging" reply is enough — don't
   wait for a severity assessment to send it.
2. **Create a tracking record** — a private GitHub Security Advisory if the
   report didn't already arrive as one. Every report gets one, even an
   email-only report, so there is a single auditable record and a place to
   attach the eventual fix PR.
3. **Do not discuss the report in any public channel** (public issues, PR
   descriptions, public Slack channels) until it is resolved and the
   coordinated-disclosure window has closed.

## Triage

Within 5 business days (target in `SECURITY.md`), the owner:

1. Reproduces the issue, or documents why it couldn't be reproduced and
   asks the reporter for more detail.
2. Assigns a severity:

   | Severity | Examples |
   |---|---|
   | Critical | Direct theft or loss of escrowed/pooled funds; unauthorized minting/withdrawal; admin takeover without a signed transaction; contract logic that bypasses multisig/governance thresholds |
   | High | Privilege escalation short of fund loss; auth bypass on a single account; SSRF/RCE on backend infrastructure; smart-contract bug exploitable only under specific, non-default config |
   | Medium | Information disclosure of non-sensitive internal data; DoS requiring privileged access; logic bugs with limited blast radius |
   | Low | Best-practice gaps with a demonstrated (if minor) exploit path; issues requiring an already-compromised account |

3. For Critical/High: loop in Engineering Lead immediately and open a
   private fix branch — do not push a fix to a public branch or open a
   public PR before the advisory is ready to publish.
4. For a smart-contract finding that is actively exploitable on a mainnet
   deployment holding real funds: treat as an active incident, not just a
   report — this can mean pausing the affected contract (see each
   contract's `pause`/`set_permissioned_mode`-style admin controls) while a
   fix is prepared. That call is Engineering Lead's, made jointly with the
   Security Team owner.

## Remediation and disclosure

1. Fix lands via the normal PR process, reviewed by someone other than the
   author, but merged from a private fork/branch until ready to disclose
   for anything above Low severity.
2. Deploy the fix (contracts: through the existing upgrade-timelock
   process where one exists; backend/frontend: normal release pipeline).
3. Confirm the fix resolves the report with the original reproduction
   steps before closing.
4. Publish the GitHub Security Advisory (converts it to a public advisory)
   once the fix is live, crediting the reporter per their preference.
5. Notify the reporter the fix has shipped and thank them — this is also
   when the 90-day coordinated-disclosure clock (`SECURITY.md`) is
   considered satisfied, whichever comes first.

## Review cadence

- Open reports are reviewed by the Security Team owner at least weekly
  until closed.
- This runbook and `SECURITY.md`'s response targets are reviewed whenever
  `scripts/check-security-txt-expiry.sh` flags the policy for renewal (at
  minimum, annually) — see `devops/SECURITY_TXT_RENEWAL.md`.
