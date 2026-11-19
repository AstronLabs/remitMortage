<!--
Copy this file to docs/adr/NNNN-short-kebab-title.md, where NNNN is the
next unused 4-digit number in docs/adr/ (check the index for the highest
one in use) and the title is a few kebab-case words describing the
decision, not the problem (e.g. 0005-off-chain-document-storage.md, not
0005-kyc-problem.md).

Fill in every section below — scripts/check-adr-format.mjs enforces that
all five headings are present, in order, with non-empty content, and that
the file is linked from docs/adr/README.md. See CONTRIBUTING.md's
"Architecture Decision Records" section for when an ADR is required.

Delete this comment block in the copy you fill in.
-->

# ADR-NNNN: Short, decision-focused title

## Status

One of: Proposed | Accepted | Superseded by ADR-NNNN | Deprecated

An ADR starts as Proposed while under review and becomes Accepted once
merged — most ADRs in this repository go straight to Accepted, since they
record a decision already made rather than one still being debated. Use
Proposed only for a decision genuinely still open for discussion in the
PR that introduces it.

## Context

What problem or question forced this decision? Describe the forces at
play — technical constraints, prior incidents, conflicting requirements —
without yet stating the decision itself. A reader unfamiliar with the
history should finish this section understanding *why a decision was
needed at all*.

## Decision

State the decision in one or two sentences, then explain it. Be concrete:
name the actual mechanism (a function, a contract, a storage layout), not
just the principle behind it, and point to where it lives in the codebase
so the ADR stays checkable against reality.

## Consequences

What does this decision make easier, harder, or simply different —
including downsides and constraints it imposes on future work, not just
benefits? An ADR that only lists upsides is a sales pitch, not a decision
record. If this decision limits a future choice (e.g. "no contract may
depend on another contract's crate"), say so explicitly here, since that
is exactly the kind of constraint this directory exists to keep from being
broken by accident.

## Alternatives Considered

What else was on the table, and specifically why it lost — not just that
it was "rejected." Include the alternative that looks obvious in hindsight
if it was genuinely considered; that is usually the most valuable part of
the record for someone who rediscovers the same idea later.
