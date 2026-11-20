# Unused export detection

Dead exports accumulate silently: a helper outlives its last caller and nothing
flags it. `npm run check:unused-exports` scans the backend source tree, records
which symbols each file exports, and cross-references those against every import
in the codebase. An export with no importer is reported.

Detection is AST-based (the TypeScript compiler API), not regex — it understands
`import`, re-exports (`export { x } from`, `export * from`), namespace imports,
dynamic `import()` and `require()`.

## Running the check

```bash
cd backend
npm run check:unused-exports
```

Equivalent direct invocation, with the available options:

```bash
npx tsx scripts/detect-unused-exports.ts \
  --root . \
  --config unused-exports.config.json \
  --json
```

- `--root <dir>` — directory to scan (default `.`, i.e. the backend package).
- `--config <file>` — config file (default `unused-exports.config.json`).
- `--json` — emit the full report as JSON instead of the human summary.
- `--fail-on-unused` — exit `1` when unused exports are found. Without this the
  report is **non-blocking** (exit `0`), which is how it is intended to run in
  CI for now.

## What is never reported

Two categories of exports are an intentional public surface and are always
suppressed:

- **Route modules** (`src/routes/**`). Handlers are registered on an Express
  router, so they are never imported by name elsewhere.
- **Barrels / index files** (`src/**/index.ts`). These re-export symbols for
  external consumers.

The pure detector defaults to exactly these globs (`DEFAULT_PUBLIC_GLOBS`), so
the list is definitional rather than an escape hatch.

## Excluding a deliberately unused export

If an export is genuinely kept despite having no in-repo importer — for example
it is part of a package surface consumed by a downstream service — add it to
`backend/unused-exports.config.json`:

```json
{
  "publicGlobs": [],
  "allowlist": ["src/services/legacy.ts#keptForExternalConsumer"]
}
```

- `allowlist` entries use the exact `<path-from-root>#<name>` form. They are
  reported under `suppressed` in `--json` output, so they stay visible for
  review rather than disappearing.
- `publicGlobs` appends extra public-surface globs to `DEFAULT_PUBLIC_GLOBS`
  (e.g. a generated client directory). Prefer the narrowest glob that covers the
  surface.

Entries are reviewed as part of the PR, so a dead export can only be kept with
sign-off.

## Default exports

Default exports are not tracked — they are consumed via the default binding of
an import rather than a named reference, which makes the name-based
cross-reference ambiguous. Wrap a value in a named export if you want it
covered.

## Suggested CI wiring

Everything the check needs is in the repository; the report is designed to run
as a non-blocking advisory step so it surfaces new dead exports without failing
the pipeline. Once the workflow is updated, the step should be:

```yaml
- name: Detect unused exports
  working-directory: backend
  run: npm run check:unused-exports
  continue-on-error: true
```

Because the step is advisory (no `--fail-on-unused`), a report never turns the
build red. Flipping it to blocking later is a one-line change: add
`--fail-on-unused` to the script, or drop `continue-on-error`.
