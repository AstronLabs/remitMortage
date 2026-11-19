# Prototype Pollution and Unsafe Deserialization Guards

Issue #885.

Merging user-supplied JSON into an object that already exists can let a caller
write to `Object.prototype`. One request then changes every object the process
creates afterwards: a missing `isAdmin` check starts returning `true`, a
default that was `undefined` starts returning an attacker's string, and nothing
in the request log looks unusual. This document describes the three layers that
stop that, and what to do when a guard gets in your way.

## The attack, concretely

```jsonc
POST /api/loan/draft
{ "__proto__": { "isAdmin": true } }
```

`JSON.parse` alone is harmless — it creates `__proto__` as an ordinary *own*
property, not a prototype link. The payload only becomes live pollution when
some line of code copies that key onto another object:

```ts
for (const key of Object.keys(source)) target[key] = source[key];  // ← the sink
Object.assign(existingSettings, req.body);                          // ← the sink
```

After either line, `({}).isAdmin === true` for the rest of the process's life.
So the defence has two halves: remove the key from the payload, and remove the
sink from the codebase.

## Layer 1 — strip at the edge

`backend/src/middleware/prototypePollutionGuard.ts` runs directly after body
parsing in `src/index.ts` and removes `__proto__`, `constructor` and
`prototype` from `req.body` and `req.query`, at any depth, before a single
handler reads them.

- **Default mode `strip`**: the keys are removed and the request is served. A
  prober gets the same response as a client that sent nothing unusual, so the
  endpoint is not an oracle.
- **Mode `reject`**: answers `400 unsafe_payload`. Use it on a route where
  receiving such a key is evidence of an attack rather than a sloppy client:
  `app.use("/api/webhooks", prototypePollutionGuard({ mode: "reject" }), …)`.

Every strip increments `remitmortgage_prototype_pollution_stripped_total`
(labels: `mode`, `route`) and writes a
`security.prototype_pollution.blocked` entry to the audit trail. A non-zero
rate on that counter means someone is probing; it is not a reason to page.

`req.params` is deliberately not swept — its keys come from the route pattern
(`/:address`), so a caller cannot introduce one.

## Layer 2 — merge and parse through the helpers

`backend/src/utils/safeObject.ts` (and its browser mirror
`frontend/src/lib/safe-object.ts`) is the only sanctioned way to fold one
object into another:

| Instead of | Use | Why |
| --- | --- | --- |
| `Object.assign(existing, src)` | `safeAssign(existing, src)` | skips the three keys; writes with `defineProperty` so an inherited setter cannot fire |
| a hand-rolled or lodash deep merge | `safeMerge(target, src)` | same, recursively, with a depth cap |
| `JSON.parse(untrustedText)` | `safeParseJson(untrustedText)` | drops the keys during parsing, so the dangerous own property never escapes |
| a lookup table keyed by user input | `createSafeRecord()` | prototype-less, so `map["toString"]` is `undefined` rather than a function |

`Object.assign({}, a, b)` — building a *new* object — was never the problem and
stays allowed.

`sanitizeDeep(value)` is available directly when you need to clean a structure
that did not arrive over HTTP (a queue message, a cached blob, an imported
file). It mutates in place and returns the paths it stripped, for logging.

## Layer 3 — freeze what is shared

`freezeCriticalPrototypes()` is the last line of `src/index.ts`'s startup
callback. It seals `Object.prototype`, `Array.prototype`,
`String`/`Number`/`Boolean`/`Map`/`Set.prototype`, so a gap in layers 1–2
throws (under strict mode) or silently no-ops instead of changing behaviour
process-wide.

Two deliberate choices:

- **`Function.prototype` is not frozen.** OpenTelemetry and Sentry patch
  function internals at require time; sealing it breaks them.
- **It runs last, after every module has loaded.** Freezing earlier would
  break a library still patching its own prototypes.

Set `PROTOTYPE_FREEZE=off` to skip the freeze — useful when bisecting a
third-party incompatibility. Layers 1 and 2 stay active either way.

## The lint gate

`scripts/check-unsafe-merge.mjs` fails CI when first-party source gains a sink.
It runs in the `Prototype Pollution — Unsafe Merge Gate` job of
`.github/workflows/security-checks.yml`, over `backend/src`, `frontend/src`,
`backend/scripts` and `scripts` (tests, mocks, `dist`, `.next` and
`node_modules` are out of scope).

| Rule | Fires on |
| --- | --- |
| `unsafe-object-assign` | `Object.assign(target, …)` where `target` is not a fresh `{}` / `[]` / `new Error(…)` |
| `unsafe-deep-merge` | `merge`, `deepMerge`, `mergeDeep`, `deepAssign`, `extend`, `defaultsDeep`, `_.set`, `setWith` |
| `unsafe-dynamic-write` | `target[req.body.field] = …` — a caller choosing the property name |
| `unsafe-json-parse` | `JSON.parse` on request, event, XHR, webhook or queue text |

Run it locally:

```bash
node scripts/check-unsafe-merge.mjs          # exit 1 on a finding
node scripts/check-unsafe-merge.mjs --json   # machine-readable
node --test scripts/check-unsafe-merge.test.mjs
```

The frontend's ESLint config carries the same merge rules as
`no-restricted-syntax` / `no-restricted-properties` / `no-proto`, so the sinks
also light up in the editor while you type.

### Waiving a finding

In order of preference:

1. Switch to `safeMerge` / `safeAssign` / `safeParseJson`. Almost always the
   right answer, and almost always a one-line change.
2. Put `// safe-merge-ok: <reason>` on the line or the line directly above it,
   when the target provably cannot be reached by untrusted keys — for example
   attaching two literal keys to an `Error`:

   ```js
   // safe-merge-ok: both keys are literals, attaching exec output to the Error
   reject(Object.assign(error, { stdout, stderr }));
   ```

A waiver without a reason is not a waiver. Reviewers should push back on one
that does not explain why untrusted keys cannot reach that target.

## Tests

| What | Where |
| --- | --- |
| Pollution payloads are neutralised; prototypes unchanged | `backend/src/__tests__/prototypePollution.test.ts` |
| Startup freeze, and the `PROTOTYPE_FREEZE=off` escape | `backend/src/__tests__/prototypeFreeze.test.ts` |
| Browser helpers | `frontend/src/lib/__tests__/safe-object.test.ts` |
| The lint gate's own rules and waivers | `scripts/check-unsafe-merge.test.mjs` |

`prototypePollution.test.ts` ends with a test that deliberately *does* pollute,
using a naive merge, and then shows `safeMerge` on the identical payload does
not. It is the executable statement of what this feature is for; keep it.

The freeze tests live in their own file because `Object.freeze` is
irreversible. Jest gives each test file its own VM context, so a freeze there
cannot leak into another suite — do not merge the two files.
