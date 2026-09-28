# Stale Feature Flag Cleanup Workflow

Report-only audit for dead feature flags. The job never deletes code.

## Schedule

`runStaleFeatureFlagAuditJob` (see `backend/src/jobs/staleFeatureFlagAudit.ts`)
runs weekly (Monday 11:00 UTC, `STALE_FLAG_AUDIT_CRON_SCHEDULE`, wired in
`backend/src/jobs/scheduler.ts`). Pure detection lives in
`backend/src/services/featureFlagAudit.ts`; the flag registry is
`backend/src/config/featureFlags.ts`.

## What counts as stale

A flag is a cleanup candidate when **all** hold:

- Rollout is terminal: `100%` with `hasVariants: false` (fully rolled out),
  or `0%` (fully killed).
- That state persisted for `>= 30` days (`STALE_FLAG_MIN_DAYS`,
  measured from `lastChangedAt`).

Mid-rollout percentages and variant-gated flags are never flagged.

## Referenced vs orphaned

Each candidate is cross-referenced against `backend/src`, `frontend/src`,
and `contracts`:

- `stale-referenced` — flag key still appears in code. Cleanup needs a PR
  that inlines the winning branch (100%) or deletes dead branches (0%)
  at every reference, then removes the flag definition.
- `stale-orphaned` — no references found. Cleanup is just removing the
  flag definition + config entry.

## Cleanup workflow (deliberate, reviewed)

1. Audit opens one tracking issue per stale flag (title
   `[flag-cleanup] Stale flag: <key> (<status>)`, labels `flag-cleanup`,
   owner tag) and emails the digest to `STALE_FLAG_DIGEST_RECIPIENTS`.
2. Owner confirms the flag is truly terminal (no planned rollback/reuse).
3. Author a removal PR: delete branches, inline constants, remove the
   registry entry, update tests. Link the tracking issue.
4. Reviewer verifies no references remain (`rg <flag-key>`) and all
   tests pass. Merge; the next audit run stops reporting the flag.
5. Never delete automatically — the job has no write path to code.
