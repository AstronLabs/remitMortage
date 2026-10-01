# Workflow Permissions Audit

With dozens of workflows under `.github/workflows/`, a workflow that never declares a `permissions:` block silently inherits the repository (or organization) default `GITHUB_TOKEN` permissions. That default can be broad, can change without this repo noticing, and widens the blast radius if a workflow — or an action it calls — is ever compromised: a compromised step in a workflow with an unnecessarily writable token can push commits, open releases, or modify issues/PRs it never needed to touch.

The **Workflow Permissions Audit** (`.github/workflows/workflow-permissions-audit.yml`, `scripts/check-workflow-permissions.mjs`) checks every workflow for least-privilege `permissions:` grants.

## What it flags

| Severity | Finding |
|---|---|
| ERROR | No `permissions:` block anywhere — neither at the workflow level nor on every job — so at least one job inherits the ambient default. |
| ERROR | `permissions: write-all` (workflow- or job-level). |
| WARNING | A `scope: write` grant with no evidence in that job's steps that the scope is actually used (e.g. `contents: write` with no `git push`/`git commit`/release-creating action). Heuristic and known to have false positives on unrecognized actions — it never fails the build. |

Read-only scopes (`contents: read`, etc.) and `permissions: read-all` are never flagged; broad read access is low-risk and usually unavoidable.

## How it runs

```
PR touching a workflow file                  Weekly (Mondays 09:00 UTC) + manual
        │                                                │
        ▼                                                ▼
 check-changed                                     full-audit
 audits only the workflow files          audits every workflow file, uploads the
 in that PR's diff — fails the           report as a job summary + artifact, and
 PR on any ERROR finding                 files/updates a single tracking issue
                                          (label `workflow-permissions-audit`) —
                                          never fails the run itself
```

The PR check only looks at files actually changed in the diff (via `git diff` against the base ref), not the whole repository. This keeps it a real merge gate for new or edited workflows without blocking unrelated PRs on pre-existing findings elsewhere in the repo. Pre-existing findings are instead tracked centrally through the weekly full-repository audit's issue, which is updated in place on every run (and closed automatically once a run comes back clean).

## Fixing a finding

**Missing `permissions:` block** — add one, scoped to what the job actually does. Prefer job-level grants over a single workflow-level block when only one job in a multi-job workflow needs write access:

```yaml
permissions:
  contents: read   # workflow-wide default

jobs:
  build:
    # inherits contents: read — read-only job
    ...
  publish:
    permissions:
      contents: read
      packages: write   # only this job pushes an image
    ...
```

**`write-all`** — replace it with the specific scopes the job's steps need. See the [permissions reference](https://docs.github.com/en/actions/using-jobs/assigning-permissions-to-jobs) for the full scope list.

**Unused-write warning** — either remove the scope if it isn't needed, or, if the action/command that uses it isn't recognized by the heuristic, leave it as-is; warnings don't block merges.

## Running it locally

```bash
# Audit everything
node scripts/check-workflow-permissions.mjs

# Audit specific files (what the PR check does)
node scripts/check-workflow-permissions.mjs .github/workflows/ci.yml

# Also write the markdown report to a file
node scripts/check-workflow-permissions.mjs --out workflow-permissions-report.md
```

Exit code is `1` if any ERROR-level finding is present among the scanned files, `0` otherwise (warnings never affect the exit code).
