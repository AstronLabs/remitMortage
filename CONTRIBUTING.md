# Contributing to Remittance-Backed Mortgage Protocol

Thank you for your interest in contributing to the **Remittance-Backed Mortgage Protocol**! This project aims to empower underserved and unbanked global citizens by turning their verified remittance history into a primary asset for securing property financing.

By contributing, you help build a decentralized, transparent, and secure infrastructure that bridges off-chain remittance verification with on-chain Soroban-based settlement.

---

## Table of Contents
1. [Code of Conduct](#code-of-conduct)
2. [Project Architecture Overview](#project-architecture-overview)
3. [Repository Structure](#repository-structure)
4. [Getting Started](#getting-started)
5. [Development Guidelines](#development-guidelines)
    - [Smart Contract Development (Soroban)](#smart-contract-development-soroban)
    - [Backend Orchestration](#backend-orchestration)
    - [Frontend Development](#frontend-development)
6. [Git Workflow & Commit Standards](#git-workflow--commit-standards)
7. [Submitting a Pull Request](#submitting-a-pull-request)

---

## Code of Conduct

We are committed to fostering a welcoming, collaborative, and professional community. Please be respectful of others, keep discussions constructive, and support fellow developers.

---

## Project Architecture Overview

The protocol is designed around a core principle: **Separating Verification from Settlement**.

*   **Verification Layer (Off-Chain):** Validates a borrower's remittance-sending history on Stellar (via Horizon/outgoing payment tracking in USDC) to generate an eligibility score.
*   **Settlement Layer (On-Chain/Soroban):** A suite of Stellar/Soroban smart contracts that manage:
    *   **Escrow Contract:** Down-payment accumulation (30% target) with exit policies (early withdrawal penalties).
    *   **Lending Pool Contract:** Investor capital staking, loan requesting, admin approvals, repayments with simple interest, and liquidity tracking.
    *   **Milestone Disbursement Contract:** Milestone-gated release of funds to contractors, verified by IPFS evidence and multisig governance.
    *   **Verification Registry:** A secure contract acting as an on-chain verification anchor.

---

## Repository Structure

```text
├── ARCHITECTURE.md          # Core architecture specification
├── README.md                # General project overview
├── implementation_plan.md   # Step-by-step development roadmap
├── contracts/               # Soroban Smart Contracts (Rust)
│   ├── Cargo.toml           # Cargo workspace file
│   ├── escrow/              # Escrow Smart Contract
│   └── lending-pool/        # Lending Pool Smart Contract
├── backend/                 # Node.js/TypeScript orchestration layer
└── frontend/                # Next.js user interface
```

---

## Getting Started

### Prerequisites

To build and test the full suite, you will need:
*   **Rust Toolchain:** Version 1.75+ (with `wasm32-unknown-unknown` target installed via `rustup target add wasm32-unknown-unknown`)
*   **Soroban CLI:** Install via `cargo install --locked soroban-cli`
*   **Node.js:** Version 18+ (with `npm` or `yarn`)

### Initial Workspace Build

1. Clone the repository and navigate to the project directory:
   ```bash
   git clone https://github.com/AstronLabs/RemitMortgage.git
   cd RemitMortgage
   ```

2. Compile and test all smart contracts:
   ```bash
   cd contracts
   cargo build --target wasm32-unknown-unknown --release
   cargo test
   ```

---

## Development Guidelines

### Smart Contract Development (Soroban)

Our smart contracts are built in Rust using the Soroban SDK.

#### 1. Directory Layout
For each contract crate (e.g., `contracts/escrow/`), maintain this modular structure:
*   `src/lib.rs` - Main contract implementation, exposed entrypoints, and tests.
*   `src/types.rs` - Structs, enums, data models, and storage keys.
*   `src/errors.rs` - Custom contract errors (`#[contracterror]`).
*   `src/token_utils.rs` - Standard Stellar Asset Contract (SAC) interaction helpers.

#### 2. Local Testing
Always verify that your code changes compile and pass unit tests locally.
```bash
cd contracts
cargo test
```
Make sure tests run clean without any warnings. Use `cargo clippy` and `cargo fmt` to maintain code quality:
```bash
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
```
These same two checks (plus a `cargo-audit` dependency scan) run in the `Security Checks` GitHub Actions workflow on every PR and **block merge** if formatting drifts or a lint/vulnerability is introduced.

**Clippy exception overrides:** Soroban SDK macros (`#[contract]`, `#[contracttype]`, `#[contracterror]`) generate code that occasionally trips a clippy lint through no fault of the hand-written code around it — a common example is a lint firing on SDK-expanded trait impls that a fully hand-written type wouldn't hit. When that happens:
*   Never silence it with a crate-wide `#![allow(...)]` — that hides the lint everywhere, including future genuine violations.
*   Scope the override to the single item that needs it, e.g. `#[allow(clippy::too_many_arguments)]` directly above the `fn`/`struct` it applies to.
*   Add a one-line comment stating *why* the override is needed (e.g. "SDK-generated constructor signature — not user-controlled"), so reviewers and `cargo clippy` alike can tell an intentional exception from an ignored warning.
*   Prefer fixing the underlying code over suppressing the lint whenever the fix doesn't fight the SDK's generated interface.

#### 3. State Management & Lifecycle
*   Use `instance` storage for global protocol configurations (e.g., admin keys, fee models, token addresses).
*   Use `persistent` storage for user-specific state records (e.g., individual borrower balances, loan structures).
*   Remember to call `.extend_ttl()` on storage keys to prevent data expiration during active use.
*   Prevent re-initialization of contracts by validating the presence of the `Config` storage key.

### Backend Orchestration
The backend is written in TypeScript and interacts with the Stellar Horizon API and Soroban RPC.
*   Write clean, modular services.
*   Document helper APIs and database migrations.
*   Ensure all cryptographic signatures are validated correctly before writing to the database.

### Frontend Development
The frontend is built using Next.js, Tailwind CSS, and Freighter Wallet.
*   Maintain clean TypeScript interfaces for all components.
*   Follow our custom design tokens (supporting modern responsive dark mode with glassmorphic visuals).

### License Header

Every source file under `backend/src`, `frontend/src`, and `contracts/*/src` must start with the MIT license header:

```text
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
```

The `License Header` CI job (`.github/workflows/license-header.yml`) scans these paths on every PR and fails with the exact file path when the header is missing. Generated and vendored paths (`node_modules`, `.next`, `target`, `dist`, `build`, `coverage`, etc.) are excluded via the documented ignore list in `scripts/license-header-ignore.json` and the built-in defaults in `scripts/check-license-header.mjs`.

**Check locally:**

```bash
node scripts/check-license-header.mjs
```

**Auto-fix locally (inserts the header without touching other content, preserves `"use client"` / `"use server"` and shebang placement):**

```bash
node scripts/check-license-header.mjs --fix
```

To exclude a generated or vendored path, add a glob to `scripts/license-header-ignore.json` and document why it is generated/vendored in the PR description.

---

## Git Workflow & Commit Standards

We follow a strict, incremental Git workflow to maintain a clear development history.

### Branch Naming Conventions
Always create a branch from `main` before starting your work:
*   `feat/` - for new features (e.g., `feat/milestone-contract`)
*   `fix/` - for bug fixes (e.g., `fix/escrow-reinitialization`)
*   `docs/` - for documentation updates (e.g., `docs/add-contributing-guide`)
*   `refactor/` - for code restructuring without changing behavior

### Semantic Commit Messages
We adhere to [Conventional Commits](https://www.conventionalcommits.org/). This helps us auto-generate changelogs and maintain consistency.

Format: `<type>(<scope>): <description>`

Examples:
*   `feat(escrow): implement early withdrawal with refund policy`
*   `test(lending-pool): add unit tests for pool operations`
*   `fix(lending-pool): prevent loan re-approvals`
*   `docs(root): create contributing guide`

Ensure each commit is a **small, modular, and compilable unit of work**.

---

## Submitting a Pull Request

1. **Keep it focused:** Try to limit each PR to a single feature, improvement, or bug fix.
2. **Write tests:** Ensure new code is covered by robust unit or integration tests.
3. **Verify locally:** Run code formatting, linting, and test commands before pushing.
4. **Draft details:** Explain the rationale behind your change in the PR description, including how it was tested.
5. **Request review:** Assign at least one project maintainer to review your code.
