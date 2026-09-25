# Terraform Version Pinning Policy

## Why We Pin Exact Versions

Terraform module and provider sources with floating version constraints
(`~>`, `>=`, `>`) resolve to the latest matching version at `terraform init`
time. A new provider or module release can silently introduce breaking changes
on the next init — affecting every environment that hasn't locked its state yet.

**The policy:** every `required_providers` entry and every registry `module`
source block in this repository must carry an **exact** version pin using the
`= X.Y.Z` operator (or a bare `X.Y.Z` string). This makes infrastructure
changes explicit, reviewable, and reproducible across all environments.

---

## What "Exact Pin" Means

| Constraint | Status | Reason |
|---|---|---|
| `version = "= 5.31.0"` | ✅ Allowed | Resolves to exactly one version |
| `version = "5.31.0"` | ✅ Allowed | Implicit `=`, same as above |
| `version = "~> 5.0"` | ❌ Blocked | Allows any 5.x — too broad |
| `version = ">= 5.0, < 6.0"` | ❌ Blocked | Range — not reproducible |
| `version = ">= 5.0"` | ❌ Blocked | Open-ended — allows breaking majors |
| *(no version attribute)* | ❌ Blocked | Implicit latest — non-deterministic |

**Exempt** sources (not checked):
- Local paths (`./`, `../`)
- Git sources (`git::`, `github.com/`, `bitbucket.org/`)
- HTTP/HTTPS direct sources

---

## CI Enforcement

The `terraform-pinning.yml` workflow runs on every PR that touches a `.tf`
file. It executes `scripts/check-terraform-pinning.mjs`, which:

1. Walks all `.tf` files in the repository (skipping `.terraform/`, `node_modules/`, etc.)
2. Extracts every `required_providers` entry and every `module` block with a
   registry source.
3. Flags any version constraint that is not an exact pin.
4. Exits `1` with a clear message per violation, e.g.:

```
✗ Terraform version pinning check FAILED — 1 unpinned source(s) found:

  File   : devops/main.tf
  Type   : provider
  Label  : aws
  Current: ~> 5.0
  Fix    : Change version = "~> 5.0" to an exact pin, e.g. version = "= X.Y.Z"

Policy: every provider and registry module source must use an exact version pin
(e.g. version = "= 5.31.0"). See docs/TERRAFORM_VERSION_PINNING.md.
```

On failure the workflow also runs `scripts/suggest-terraform-pins.sh`, which
queries the Terraform Registry for the latest published version and prints a
ready-to-copy `sed` command.

---

## How to Fix a Failing Check

### Step 1 — Find the latest version

**Option A — use the suggest script (recommended):**
```bash
bash scripts/suggest-terraform-pins.sh
```
This queries the Terraform Registry and prints a `sed` command for each violation.

**Option B — look it up manually:**
- Providers: `https://registry.terraform.io/providers/<namespace>/<type>/latest`
- Modules: `https://registry.terraform.io/modules/<namespace>/<module>/<provider>/latest`

### Step 2 — Update the `.tf` file

```hcl
# Before (floating)
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# After (exact pin)
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 5.31.0"
    }
  }
}
```

### Step 3 — Regenerate the lock file

```bash
cd devops/
terraform init -upgrade
# Commit both the .tf file and .terraform.lock.hcl
```

### Step 4 — Verify locally

```bash
node scripts/check-terraform-pinning.mjs
```

---

## How to Intentionally Bump a Pinned Version

Bumping a pin is an intentional, reviewed change — not something that should
happen silently. The process:

1. **Decide** — confirm the new version is tested and changelog-reviewed.
2. **Update** — change the version in the `.tf` file.
3. **Reinit** — run `terraform init -upgrade` to update `.terraform.lock.hcl`.
4. **Plan** — run `terraform plan` in a non-production workspace and review the diff.
5. **PR** — open a PR with the updated `.tf` and lock file. The pinning CI check
   will pass because the new constraint is still exact.
6. **Apply** — merge and deploy via the standard workflow.

---

## Running the Check Locally

```bash
# Check the whole repo (run from repo root)
node scripts/check-terraform-pinning.mjs

# Check a specific subdirectory
node scripts/check-terraform-pinning.mjs devops/

# Get auto-fix suggestions
bash scripts/suggest-terraform-pins.sh
```
