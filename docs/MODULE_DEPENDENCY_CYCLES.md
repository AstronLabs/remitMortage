# Backend module dependency cycles

Circular imports between backend modules can creep in unnoticed and cause subtle
initialization-order bugs: whichever module is loaded first sees the other
half-initialized. `backend/scripts/check-module-cycles.ts` builds the import
graph of `backend/src` and fails when a cycle is introduced.

## What it checks

Only **runtime** edges count. The following are ignored because the compiler
erases them and they cannot affect initialization order:

- `import type { ... } from "..."` and all-`type` named imports
  (`import { type A, type B } from "..."`)
- `export type { ... } from "..."`

Everything else is followed, including side-effect imports
(`import "./setup.js"`), `import(...)` and `require(...)` of a relative path.
A cycle is a strongly connected component of more than one module, or a module
that (transitively) imports itself. `__tests__` and `test-utils` are not part of
the shipped graph and are skipped.

## Running it locally

```bash
cd backend
npm run check:module-cycles          # exit 1 when a new cycle is found
npx tsx scripts/check-module-cycles.ts --json   # machine-readable report
```

## The baseline

Cycles that already existed when the check was added are listed in
`backend/scripts/module-cycles-baseline.json` so the gate could land without
failing on pre-existing problems. Only a cycle that is **not** in the baseline
fails the check, which is what makes a newly introduced cycle visible in CI.

The baseline is currently empty — the backend graph has no cycles. When a cycle
is broken, delete its entry from the baseline file so it can never return
unnoticed. The script also reports baseline entries that no longer cycle as
stale.

Regenerate the baseline after an intentional, reviewed cycle is accepted:

```bash
cd backend
npm run check:module-cycles:update-baseline
```

Prefer breaking the cycle over baselining it. A baseline entry is a debt, not a
fix.

## Resolving a reported cycle

The error lists the modules involved, e.g.:

```
[module-cycles] 1 new import cycle(s):
  - services/a.ts -> services/b.ts -> services/c.ts
```

Work through it in this order:

1. **Check whether the edge is really a type import.** If `a.ts` only needs a
   type from `c.ts`, change the import to `import type { ... }` (or move the
   type into a `types.ts` leaf). Type-only edges are erased and do not form a
   runtime cycle.
2. **Extract the shared piece.** If two modules in the cycle genuinely need each
   other's values, move the shared value (a constant, a small helper, or an
   interface) into a third module that both import. The new module must not
   import back into the cycle.
3. **Invert one direction with a parameter.** Instead of `b.ts` importing
   `a.ts`, have the caller pass the needed function in (dependency injection) or
   register it via a callback/hook, so the lower module no longer depends on the
   higher one.
4. **Lazy-load at the call site.** When the dependency is only needed at
   runtime inside a function, use a dynamic `import(...)` there instead of a
   static top-level import. This is a last resort — it hides the dependency from
   the graph, so keep it rare and commented.

Once the cycle is gone, the check passes and the baseline needs no change (it
was never listed).

## In CI

Run `npm run check:module-cycles` from `backend/` as a required check; a
non-zero exit fails the build and the offending modules are printed with
GitHub `::error` annotations.
