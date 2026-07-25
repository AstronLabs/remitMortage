# RemitMortgage
A decentralized remittance-backed mortgage protocol built on Stellar.

RemitMortgage enables diaspora communities to leverage their verified remittance-sending history as proof of creditworthiness to access property financing. By utilizing Soroban smart contracts, USDC escrow savings, milestone-gated construction disbursements, and multisig governance, it replaces inaccessible traditional mortgage systems with a transparent, on-chain alternative.

It's the bridge between consistent remittance behavior and real homeownership.

## Motivation
Millions of people in the global diaspora send money home every month — consistently, reliably, for years. Yet this financial track record is invisible to traditional lenders. Banks don't recognize cross-border remittance history as proof of creditworthiness, leaving hardworking families locked out of property ownership in their home countries.

RemitMortgage makes remittance history count:

*   **Prove Your Track Record:** Verify ownership of wallets used to send remittances and let the protocol analyze your Stellar payment history for consistency and reliability.
*   **Save Toward Ownership:** Contribute 30% down payment over 6–12 months into a Soroban escrow contract, earning yield on pooled funds while you save.
*   **Build With Accountability:** The remaining 70% is disbursed from a lending pool in milestone-based tranches to vetted contractors — gated by photo/video evidence on IPFS and multisig governance approval.

## Features
*   **Remittance Verification** — Off-chain scoring service analyzes Stellar payment history for recurring amounts, regular intervals, and sustained sending patterns to establish borrower eligibility.
*   **Escrow Savings Contract** — Soroban smart contract holds USDC contributions over 6–12 months, tracks individual balances, and enforces early withdrawal penalties (configurable basis points).
*   **Lending Pool Contract** — Investor capital deposits, loan requesting/approval, milestone-based disbursement, and borrower repayment with simple interest — all on-chain.
*   **Milestone Disbursement** — Construction funds released only when IPFS-hashed photo/video evidence is submitted and approved by a multisig governance committee.
*   **Multisig Governance** — Stellar native multi-signature accounts gate milestone approvals, with configurable signer weights and thresholds.
*   **Stablecoin Settlement** — All contributions, disbursements, and repayments settle in USDC on Stellar with sub-cent fees and 3–5 second finality.
*   **Yield on Escrow** — Pooled escrow funds can be routed into Soroban-based lending protocols to earn passive yield while accumulating.

## Stack
*   **Frontend:** Next.js, TypeScript, Tailwind CSS
*   **Wallet:** Freighter + `@stellar/freighter-api`
*   **Smart Contracts:** Rust, Soroban SDK v22
*   **Backend:** Node.js/TypeScript, Stellar SDK (`js-stellar-sdk`)
*   **Database:** PostgreSQL (off-chain applicant records)
*   **Storage:** IPFS via Pinata (milestone evidence)

## Running it locally

For local offline testing, you can spin up a local mock Stellar network (including Horizon, Soroban RPC, and Friendbot) in a Docker container using Docker Compose. Refer to the [Stellar Quickstart Docker Sandbox Guide](docs/LOCAL_SANDBOX.md) for detailed instructions on setting up and deploying contracts locally.

### Prerequisites
*   Node.js ≥ 18.0.0
*   Rust (latest stable) + `wasm32-unknown-unknown` target
*   Stellar CLI — `cargo install stellar-cli`
*   [Freighter Wallet](https://www.freighter.app/) browser extension

### 1. Setup Frontend
```bash
cd frontend
npm install
```

Configure `frontend/.env.local`:
```env
NEXT_PUBLIC_ESCROW_CONTRACT_ID=your_escrow_contract_id
NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID=your_lending_pool_contract_id
NEXT_PUBLIC_USDC_TOKEN_ID=your_usdc_token_id
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
```

Run the dev server:
```bash
npm run dev
```

### 2. Setup Contracts
To build and test the smart contracts:
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
cargo test
```

## How Remittance-Backed Mortgages Work
RemitMortgage coordinates the entire homeownership journey on-chain through five phases:

1.  **Verification:** The borrower proves ownership of their remittance-sending wallet(s) by signing a message. The backend queries Stellar Horizon for their outgoing USDC payment history and scores it for consistency — recurring amounts, regular intervals, and sustained behavior.
2.  **Savings:** The borrower contributes toward a 30% down payment over 6–12 months into the Soroban escrow contract in USDC. Pooled funds can earn yield via integrated lending protocols.
3.  **Loan Approval:** Once the 30% target is met, the escrow releases funds and the borrower requests a loan from the lending pool for the remaining 70%. The admin (or governance committee) approves the loan after verifying pool liquidity.
4.  **Construction:** The 70% is disbursed in milestone-based tranches to whitelisted contractors and suppliers. Each tranche requires IPFS-hashed photo/video evidence of completed work, reviewed and approved by a multisig governance committee.
5.  **Repayment:** The borrower repays the 70% loan over time in USDC, settling instantly on Stellar with sub-cent transaction fees.

## Roadmap
*   **Verification Registry Contract:** On-chain anchor for borrower verification reports — store eligibility hashes for auditability without exposing private data.
*   **Milestone Disbursement Contract:** Full implementation of IPFS evidence submission, multisig approval gating, and milestone-tracked fund releases.
*   **Credit Scoring Engine:** Automated off-chain service that generates borrower eligibility scores from Stellar transaction history analysis.
*   **Yield Integration:** Route idle escrow funds into Soroban lending protocols (e.g., Blend Capital) to earn passive yield during the savings phase.
*   **Frontend Dashboard:** Borrower portal for savings tracking, loan status, repayment schedules, and milestone progress visualization.

## Documentation
*   [Architecture](ARCHITECTURE.md): Core principle of separating verification from settlement, contract suite design, and end-to-end flow.
*   [Stellar Quickstart Docker Sandbox Guide](docs/LOCAL_SANDBOX.md): Instructions to spin up a local mock network and deploy contracts offline.
*   [Contributing Guide](CONTRIBUTING.md): How to set up locally, branch conventions, commit standards, and PR guidelines.

## Testing on Testnet

Comprehensive testnet instructions are available in the docs folder:

- docs/DEPLOYMENT.md — deployment steps, building WASM, and initializing contracts.
- docs/TESTNET_SETUP.md — Friendbot, Freighter, and minting/testing USDC tips.
- docs/E2E_TESTING.md — end-to-end borrower walkthrough with example CLI commands.

Refer to those guides to deploy contracts, fund wallets, and exercise the full borrower lifecycle on Stellar testnet.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
