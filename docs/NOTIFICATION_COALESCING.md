# Notification coalescing

A burst of identical events — a handful of failed sign-in attempts in a row,
say — can otherwise queue one notification per event and flood the recipient
with near-duplicate messages. `backend/src/services/notificationCoalescer.ts`
folds those bursts into a single message.

## How it works

A `NotificationCoalescer` keeps one window per `(type, recipient)` pair:

1. The **first** trigger of a burst returns `deliver: true`, so the caller sends
   its notification immediately — the user still gets prompt feedback.
2. Any further trigger **within the window** is folded into the pending window:
   it returns `deliver: false` and increments the running count. No email is
   sent for it.
3. When the window closes, the `flush` callback fires **once** for the burst,
   reporting the total `count` and a `sample` of the folded payload. A window
   that only ever saw a single trigger is never flushed.

```ts
import { NotificationCoalescer, DEFAULT_COALESCE_WINDOW_MS } from "./services/notificationCoalescer.js";

const coalescer = new NotificationCoalescer<{ recipient: string }>({
  windowMs: DEFAULT_COALESCE_WINDOW_MS,
  flush: (_key, count, sample) => {
    // one combined notification for the whole burst
    void sendEmail(sample.recipient, `You triggered ${count} events`);
  },
});

const { deliver, count } = coalescer.record(
  { type: "LOGIN_FAILED", recipient: "a@example.com" },
  { recipient: "a@example.com" }
);
if (deliver) {
  void sendEmail("a@example.com", "Security alert");
}
```

## Keying

Windows are keyed by `type` + `recipient`. Distinct notification *types* for the
same recipient, or the same type for different recipients, are never merged —
each gets its own window.

## Defaults

`DEFAULT_COALESCE_WINDOW_MS` is **30 000 ms** (30 s): long enough to absorb a
quick burst of retries, short enough that a folded message still feels live.

## Determinism in tests

The scheduling primitive is injectable (`schedule` / `cancel`, defaulting to
`setTimeout` / `clearTimeout`), so tests can drive window close with fake timers
instead of real delays. `clear()` cancels every pending window without flushing;
`lockoutService` exposes `_resetLockoutNotificationCoalescer()` for test
teardown.

## Current use: lockout alerts

Repeated lockouts for the same account are indistinguishable to the user, so
[lockoutService.ts](../backend/src/services/lockoutService.ts) routes its
`sendLockoutNotificationEmail` calls through the coalescer. The first lockout
emails immediately; rapid repeats are folded, and the combined email reports how
many lockout events it represents (`occurrences`).

## Scope

Coalescing is **in-process**. Each backend instance keeps its own windows, so
across a horizontally scaled deployment a burst may still produce one
notification per instance. That is acceptable here — coalescing is a
flood-reduction measure, not an exactly-once guarantee.
