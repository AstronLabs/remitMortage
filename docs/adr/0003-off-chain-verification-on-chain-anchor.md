# ADR-0003: Off-chain verification data, on-chain hash anchors only

## Status

Accepted

## Context

Borrower eligibility is derived from sensitive data: remittance payment
history, KYC documents (government ID, proof of address, employment
verification), and the resulting eligibility score. Two constraints are
in direct tension:

- The protocol's settlement layer (escrow, lending, disbursement) is
  on-chain so that fund movement is auditable and non-custodial.
- Everything written to a public blockchain ledger is permanently public
  and un-redactable. A government ID image, a full remittance payment
  history, or raw employment records stored on-chain would be exposed
  forever to anyone who can read the chain — including to parties the
  borrower never consented to share with, and with no way to later
  comply with an erasure request.

A protocol that needs both "on-chain settlement" and "sensitive personal
data" cannot put the second thing on the first layer.

## Decision

Verification and KYC data lives entirely off-chain, in the backend's
Postgres database and object storage (S3/GCS, see
`backend/src/services/kycStorage.ts`, `documentUpload.ts`). The chain only
ever sees a **cryptographic hash** of a verification report plus a
pass/fail-style status and a score, anchored by the
`verification-registry` contract — never the underlying documents,
payment history, or any personally identifying field.

This is stated as the contract's own reason for existing, in its own
top-of-file documentation
(`contracts/verification-registry/src/lib.rs`):

> Acts as an on-chain anchor for borrower eligibility verification
> reports. Rather than storing sensitive financial datasets on-chain,
> only the cryptographic hash of each report is anchored here, allowing
> third parties to audit that a borrower was verified without exposing
> the underlying data.

The same split applies to milestone evidence in the `milestone` contract:
photo/video proof of construction progress is pinned to IPFS (an
off-chain, content-addressed store), and only the IPFS content hash is
recorded on-chain, referenced by the governance/multisig approval that
releases the corresponding disbursement.

The architectural framing is stated directly in `CONTRIBUTING.md`'s
Project Architecture Overview: the protocol is designed around
**"Separating Verification from Settlement"** — a Verification Layer
(off-chain) that produces an eligibility result, and a Settlement Layer
(on-chain/Soroban) that only ever acts on that result's hash/score, never
on the data that produced it.

## Consequences

- An auditor or counterparty can verify on-chain that a specific,
  hash-identified report was the one used for a decision (tamper-evidence)
  without the protocol exposing what that report actually contained.
- The backend's off-chain store becomes the thing that must satisfy data
  protection/erasure requirements (see `erasureWorkflow.ts`,
  `anonymize-staging-seed.ts`) — the chain-anchored hash is, by
  construction, never personally identifying on its own and needs no
  erasure, but the backend's copy of the underlying document does.
- Any feature that wants to make a verification artifact "trustless" by
  putting it fully on-chain is explicitly out of bounds for anything that
  could be sensitive personal data — the hash-anchor pattern is the only
  sanctioned way to get an on-chain audit trail for that class of data.
  The same applies to any new sensitive field: it does not get a new
  on-chain storage key, it gets hashed and anchored the same way.
- On-chain code can never independently recompute or validate the
  *content* behind a hash — only that a given off-chain report matches
  what was anchored. Trust in the matching between a hash and its
  original document rests entirely on the backend's own integrity
  (access control, audit logging on the off-chain store), not on the
  chain.
- IPFS content (milestone evidence) is only as available as the pinning
  service keeping it pinned; the on-chain hash proves what the content
  *was*, not that it still exists anywhere to be fetched — the protocol
  depends on its pinning infrastructure for only that side of durability.

## Alternatives Considered

- **Store verification data on-chain directly, encrypted.** Rejected:
  Soroban contract storage is not designed or priced for large encrypted
  blobs, and "encrypted forever on a public, immutable ledger" still means
  the ciphertext is permanently stored where it can one day be attacked
  or where a future key-management failure exposes it — there is no way
  to later delete it even if the encryption is eventually broken or the
  key is compromised, which an erasure request fundamentally requires.
- **A fully off-chain system with no on-chain anchor at all.** Simpler,
  and avoids the gas/storage cost of anchoring, but gives up the one
  property the anchor buys: third-party-auditable proof that a specific
  verification result (not a different, later-substituted one) was what
  actually gated a loan decision. Rejected because that auditability is
  core to the protocol's "transparent, non-custodial" value proposition
  stated throughout `ARCHITECTURE.md`.
- **A dedicated oracle/attestation network instead of this protocol's own
  `verification-registry` contract.** Would decouple verification from
  this specific team's infrastructure, but introduces a third-party trust
  dependency and integration cost disproportionate to the protocol's
  current scale. Not adopted at launch; revisit if verification needs to
  scale beyond what a single backend + on-chain registry can support.
