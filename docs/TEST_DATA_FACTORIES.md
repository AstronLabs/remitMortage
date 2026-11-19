# Shared Test Data Factories

Tests build loans, applicants and milestones through typed factories in
`backend/src/test-utils/factories/` instead of writing object literals inline.
A model change then means updating **one factory**, not dozens of fixtures, and
tests stop quietly encoding different assumptions about what a "loan" is.

## Using a factory

```ts
import {
  applicantFactory,
  loanFactory,
  loanRowFactory,
  milestoneProposalFactory,
  resetFactorySequences,
} from "../test-utils/factories/index.js";

beforeEach(() => resetFactorySequences()); // deterministic ids: loan-1, loan-2, ...

const loan = loanFactory.build({ amount: "9000" });                 // one call + targeted override
const overdue = loanRowFactory.overdue(14).build();                 // named variant
const verified = applicantFactory.verified().build();               // named variant
const approved = milestoneProposalFactory.approved().build();
const many = loanFactory.buildMany(3, (i) => ({ amount: String((i + 1) * 100) }));
```

Builders are **immutable and fluent**: `with()` and the named variants return a
new builder, so shared builders are safe to reuse and chain
(`loanRowFactory.overdue().with({ missedPayments: 3 }).build()`). `with()` and
`build()` deep-merge nested objects, so `loanRowFactory.build({ applicant: { verificationStatus: "INELIGIBLE" } })`
keeps the applicant's other fields.

## What exists

| Factory | Produces | Named variants |
| --- | --- | --- |
| `applicantFactory` | `Applicant` row | `verified()`, `ineligible()`, `pending()`, `deleted()`, `snapshot()` (the auto-rejection engine's input) |
| `loanFactory` | API-level `LoanApplication` (what `loanStore` returns) | `draft()`, `pending()`, `approved()`, `rejected()`, `disbursing()`, `repaying()`, `completed()`, `manualReview()` |
| `loanRowFactory` | Persisted `LoanApplication` row with its applicant (what Prisma returns) | `pending()`, `approved()`, `rejected()`, `repaying()`, `overdue(days)`, `completed()`, `softDeleted()`, `forApplicant()` |
| `milestoneProposalFactory` | `MilestoneProposal` | `open()`, `approved()` (status `Passed`), `rejected()` |

Defaults are the cheapest valid entity; dates are anchored to `FACTORY_EPOCH`
(2026-10-01) so tests never depend on the wall clock. Stellar addresses come
from `stellarAddress(seed)`: checksum-valid and unique per factory call.

## Changing a model

1. Update the entity type/row interface and the `makeDefaults` function in the
   matching factory file — nothing else.
2. `testFactories.test.ts` compares the `Applicant` and `LoanApplication`
   factories with `prisma/schema.prisma`: it fails if a factory sets a field the
   model no longer has, or omits a required field without a database default.

## Adding a factory

Extend `Builder<T>` (see `milestone.ts` for the smallest example), give it a
`makeDefaults(seq)` and the named variants the tests need, and export it from
`index.ts`. Add the entity's identifying properties to
`INLINE_FIXTURE_PATTERNS` in `test-utils/inlineFixtureCheck.ts` if it should be
guarded too.

## Discouraging inline fixtures

The backend has no ESLint toolchain, so the "lint rule" is a ratcheted test,
`src/__tests__/noInlineFixtures.test.ts`:

- A test file that spells out a loan/applicant/milestone literal
  (`borrowerAddress:`, `stellarAddress:`, `verificationStatus: "ELIGIBLE"`,
  `evidenceCid:`, `missedPayments:`) fails — unless it only passes overrides
  *into* a factory call.
- Legacy files are listed in `src/test-utils/inline-fixture-baseline.json`. The
  list may only shrink: migrate a file, then delete its entry (the test fails
  if a baselined file no longer needs to be there).
- A deliberate exception is marked `// fixture-ok: <reason>` (for example, a
  test asserting the raw wire format).

The same expectation is in the PR checklist (`.github/pull_request_template.md`).

## Migrated so far

`autoRejectionRules`, `adminPortfolioDigest`, `optimisticLocking` and
`loanAsOf` use the factories. The remaining files are in the baseline above.
