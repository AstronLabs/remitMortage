# Environment Configuration

## Demo Mode

RemitMortgage supports a **demo / sandbox mode** that lets frontend developers and
integration testers exercise API routes without a live Stellar network. When
enabled, certain endpoints skip real contract interactions and return mock data.

### Enabling Demo Mode

Set the following environment variable:

```env
DEMO_MODE=true
```

### What Demo Mode Affects

The following routes are demo-gated and return mock responses when the flag is on:

- Loan repayment and disbursement endpoints
- Escrow deposit and release operations
- Milestone proposal and approval flows

A separate request rate limiter (`demo-rate-limit.ts`) caps demo endpoints at
10 requests per minute per IP to prevent abuse.

### Demo Mode Middleware

The `requireDemo` middleware (`backend/src/utils/demo.ts`) returns a 403 when a
demo-gated route is accessed without the flag set. Apply it to any route that
should only function in demo mode:

```ts
import { requireDemo } from "../utils/demo.js";
router.post("/loan/repay", requireDemo, repayHandler);
```

### Rate Limiting

When `DEMO_MODE=true`, a strict rate limiter is active on demo-gated routes.
See `backend/src/utils/demo-rate-limit.ts` for configuration details.

---

## General Configuration

Refer to `.env.example` at the project root for the full list of supported
environment variables, including Stellar network settings, database connection
strings, CORS origins, contract IDs, and API keys.

### Product usage analytics

Product usage analytics is enabled by default. Set the following variable to
`false` to disable frontend tracking and backend persistence without changing
application code:

```env
ANALYTICS_ENABLED=false
NEXT_PUBLIC_ANALYTICS_ENABLED=false
```

Authenticated events are buffered through the existing Redis/BullMQ analytics
queue and persisted in PostgreSQL in batches. Run the backend worker with the
same Redis configuration as the API process so queued events are drained.
