# RemitMortgage Soroban Deployment & Interaction Scripts

This directory contains utility scripts to automate the building, deployment, initialization, and validation of the RemitMortgage Soroban smart contracts on Stellar Testnet.

## Prerequisites

Ensure you have the following installed on your machine:
- **Rust & Cargo** (configured with the `wasm32-unknown-unknown` target)
- **Stellar CLI** (latest version supporting Soroban contract interactions)
- **OpenSSL** (used in the demo script to generate random 32-byte loan IDs)

---

## Configuration

The deployment and initialization scripts store and read settings using a temporary `.env.deployed` file in the root workspace directory. You can also specify an override for the testnet USDC token address by exporting the `USDC_TOKEN_ID` environment variable:

```bash
export USDC_TOKEN_ID="CCW65FM7TA24VK724JE5SJLPT4SCA7F647E6S5JJKMJT2E2E6S5SJL36"
```

If not provided, the scripts fall back to a default mock USDC asset address.

---

## Available Scripts

### 1. Build & Optimize (`scripts/build.sh`)
Compiles all workspace contracts to the `wasm32-unknown-unknown` target in release mode and optimizes the output WASM binaries using the Stellar CLI.
- **Run:** `./scripts/build.sh`
- **Output:** Optimized WASM files will be saved in `target/wasm32-unknown-unknown/release/*.optimized.wasm`.

### 2. Testnet Deployment (`scripts/deploy-testnet.sh`)
Deploys the optimized `escrow`, `lending_pool`, and `milestone` contract WASMs to the Stellar Testnet.
- **Run:** `./scripts/deploy-testnet.sh [identity_name]`
- **Arguments:**
  - `identity_name` (Optional, defaults to `deployer`): The Stellar CLI identity/account to use for deploying. If the identity does not exist, the script automatically generates and funds it via Friendbot.
- **Output:** Deployed contract IDs are saved in `.env.deployed`.

### 3. Contract Initialization (`scripts/initialize.sh`)
Invokes the `initialize` function on each deployed contract with configured variables and cross-references.
- **Run:** `./scripts/initialize.sh`
- **Actions:**
  - Configures the **Escrow** target parameters, duration, and penalty tiers.
  - Configures the **Lending Pool** admin, token, and interest rates.
  - Configures the **Milestone** contract with the linked Lending Pool address.

### 4. End-to-End Demo Flow (`scripts/demo.sh`)
A complete simulation script that demonstrates end-to-end functionality of the core borrower flow on the live testnet.
- **Run:** `./scripts/demo.sh`
- **Simulated Steps:**
  1. Generates and funds `borrower` and `investor` test keys via Stellar CLI.
  2. Borrower approves the Escrow contract and deposits **10,000 USDC** (matching the savings target).
  3. Investor approves the Lending Pool contract and deposits **100,000 USDC** to provide capital.
  4. Borrower requests a **70,000 USDC** loan.
  5. Deployer/Admin approves the loan request on the Lending Pool contract.

---

### 5. License Header Enforcement (`scripts/check-license-header.mjs`)

Ensures every `backend/src`, `frontend/src`, and `contracts/*/src` source file carries the required MIT license header. The `License Header` CI job (`.github/workflows/license-header.yml`) runs this check on every PR and fails with the exact file path when the header is missing.

- **Check:** `node scripts/check-license-header.mjs`
- **Auto-fix (local):** `node scripts/check-license-header.mjs --fix` — inserts the two-line header at the top of each missing file without altering other content. Correctly handles `"use client"` / `"use server"` directives and `#!` shebangs by inserting after them, and is idempotent.
- **Ignore list:** `scripts/license-header-ignore.json` (`{ "ignore": ["glob/**"] }`) plus built-in defaults (`node_modules`, `.next`, `target`, `dist`, `build`, `coverage`, `.terraform`, `next-env.d.ts`, `*.wasm`, etc.) — see `DEFAULT_IGNORE_PATTERNS` in the script. Document any added pattern as generated/vendored in the PR.
- **Required header (first lines of file):**
  ```
  // Copyright (c) 2026 RemitMortgage Protocol Contributors
  // SPDX-License-Identifier: MIT
  ```

## Execution Walkthrough

To perform a clean build, deploy, initialize, and test the contracts from scratch:

```bash
# Step 1: Build contracts
./scripts/build.sh

# Step 2: Deploy to Testnet
./scripts/deploy-testnet.sh deployer

# Step 3: Initialize contract configurations
./scripts/initialize.sh

# Step 4: Run the validation demo
./scripts/demo.sh
```
