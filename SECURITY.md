# Security Policy

RemitMortgage welcomes reports from security researchers. This document is
the canonical disclosure policy referenced by
[`/.well-known/security.txt`](frontend/public/.well-known/security.txt) on
every RemitMortgage domain.

## Reporting a vulnerability

Use whichever of these you're more comfortable with:

- **Email:** security@remitmortgage.com — encrypt sensitive details with our
  [PGP key](frontend/public/.well-known/pgp-key.txt)
  (fingerprint `DF8A 873B 671E F26C 71D7  7D2E C05E BDBB AF26 16DA`).
- **GitHub Security Advisory:** open a
  [private advisory](https://github.com/AstronLabs/remitMortage/security/advisories/new)
  on this repository.

Please do **not** open a public GitHub issue for a suspected vulnerability.

Include, as applicable: affected URL/contract/endpoint, steps to reproduce,
impact, and any proof-of-concept. Reports in English are preferred
(`Preferred-Languages: en`).

## Scope

**In scope:**
- The `remitmortgage.com` web application and its `/api/*` backend.
- The Soroban smart contracts in `contracts/` as deployed on Stellar
  mainnet/testnet under this organization's published contract IDs.
- Infrastructure and CI/CD configuration committed to this repository.

**Out of scope:**
- Third-party services we depend on but do not control (Stellar network
  itself, Horizon/RPC providers, email/SMS/KYC providers, cloud providers) —
  report those to their own security teams.
- Findings that require physical access to a user's device, a already
  compromised user account/keys, or social engineering of RemitMortgage
  staff or users.
- Denial-of-service achieved purely through volume (e.g. request flooding)
  rather than an amplification or resource-exhaustion defect — low-and-slow
  or algorithmic-complexity DoS is in scope.
- Missing security headers, SPF/DMARC tuning, or other best-practice
  advisories with no demonstrated exploit path (we're happy to hear about
  them, but they're triaged as hardening suggestions, not vulnerabilities).
- Vulnerabilities in outdated browsers or unsupported dependency versions
  that the reporter controls (e.g. a self-hosted fork).

## Safe harbor

We will not pursue legal action against, and consider authorized, any
security research conducted:

- In good faith, consistent with this policy, and strictly for the purpose
  of identifying and reporting a vulnerability to us;
- Without accessing, modifying, or exfiltrating data beyond what is
  strictly necessary to demonstrate the vulnerability;
- Without disrupting production services, including smart contracts holding
  real funds — use testnet deployments and test accounts wherever possible;
- Without publicly disclosing the issue before we have had a reasonable
  opportunity to remediate it (see response targets below).

If a third party initiates legal action against you for activity conducted
in compliance with this policy, we will make it known that your actions
were authorized.

This safe harbor does not extend to testing against mainnet contracts in a
way that risks user funds, or to any activity prohibited by applicable law
regardless of this policy's intent.

## Response targets

| Stage | Target |
|---|---|
| Acknowledgment of a new report | 2 business days |
| Initial triage and severity assessment | 5 business days |
| Status update cadence while open | At least every 10 business days |
| Remediation target, critical severity | 30 days |
| Remediation target, high severity | 90 days |
| Remediation target, medium/low severity | Next regular release cycle |

Coordinated disclosure: we ask for 90 days from acknowledgment (or until a
fix ships, if sooner) before any public disclosure of the finding. We will
credit reporters who want credit once a fix is live, unless anonymity is
requested.

## Internal triage ownership

The on-call security owner and the full internal triage workflow are
documented in [`devops/SECURITY_INCIDENT_TRIAGE.md`](devops/SECURITY_INCIDENT_TRIAGE.md)
(internal — references ownership and escalation paths not relevant to
external reporters).

## Keeping this policy current

- `security.txt`'s `Expires` field and this policy's response targets are
  reviewed at least annually, and any time ownership changes.
- `scripts/check-security-txt-expiry.sh` runs daily
  (`.github/workflows/security-txt-expiry.yml`) and alerts when
  `security.txt` is within 30 days of expiry, already expired, or fails to
  load — see [`devops/SECURITY_TXT_RENEWAL.md`](devops/SECURITY_TXT_RENEWAL.md)
  for the renewal procedure.
