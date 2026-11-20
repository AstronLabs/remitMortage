# Prisma enum mirrors

Some enums are declared in TypeScript as a string-literal union (so a module
type-checks without `prisma generate` having run) even though the same values
live in `backend/prisma/schema.prisma`. Nothing in the database or the generated
client forces the two to agree, so a value added on one side can silently drift
from the other:

```ts
// backend/src/services/db.ts
export const VERIFICATION_STATUSES = ["PENDING", "ELIGIBLE", "INELIGIBLE"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
```

```prisma
// backend/prisma/schema.prisma
enum VerificationStatus {
  PENDING
  ELIGIBLE
  INELIGIBLE
}
```

`backend/src/__tests__/prismaEnumMirrors.test.ts` parses the schema and fails
when a paired enum has a value on one side only — catching a new Prisma enum
value with no TypeScript counterpart, or vice versa.

## Adding a new enum pair

One step:

1. Export the values as an `as const` array from the module that declares the
   mirror, and derive the union type from it (see `VERIFICATION_STATUSES` above).
2. Add a single entry to `MIRRORS` in
   `backend/src/__tests__/prismaEnumMirrors.test.ts`:

   ```ts
   { prismaEnum: "WorkspaceRole", values: WORKSPACE_ROLES, declaredIn: "services/workspace.ts" },
   ```

That's it — the test compares the array against the `enum` of the same name in
`prisma/schema.prisma`. Value order does not matter; only the set of values.

## Which enums are paired

Only enums documented as mirrors are registered:

| Prisma enum | TypeScript values | Declared in |
|-------------|-------------------|-------------|
| `VerificationStatus` | `VERIFICATION_STATUSES` | `backend/src/services/db.ts` |
| `NotificationFrequency` | `NOTIFICATION_FREQUENCIES` | `backend/src/services/db.ts` |
| `GuarantorStatus` | `GUARANTOR_STATUSES` | `backend/src/services/loanStore.ts` |
| `ReviewerStatus` | `REVIEWER_STATUSES` | `backend/src/services/assignmentQueue.ts` |
| `CommunicationCategory` | `COMMUNICATION_CATEGORIES` | `backend/src/services/communicationPreferences.ts` |
| `CommunicationChannel` | `COMMUNICATION_CHANNELS` | `backend/src/services/communicationPreferences.ts` |

Two same-named types are intentionally **not** paired because they are not
strict mirrors:

- `LoanStatus` (`backend/src/services/loanStore.ts`) carries the app-only
  `MANUAL_REVIEW` state, so it is a superset of the Prisma enum.
- `CommunicationChannel` (`backend/src/services/communicationTimeline.ts`) is an
  email/SMS/in-app view, not the stored `EMAIL`/`SMS`/`PUSH` preference enum.

Most other Prisma enums (e.g. `WorkspaceRole`, `AutoRejectionRuleType`,
`WebhookSubscriptionStatus`) are consumed as `import type { ... } from
"@prisma/client"`, so they cannot drift and need no mirror.

## Running the test locally

```bash
cd backend
npx jest src/__tests__/prismaEnumMirrors.test.ts
```
