# Error Codes

Auto-generated from `contracts/*/src/errors.rs` by `scripts/check_error_codes_sync.py --write`. Do not edit by hand — update the doc comments in the source enum and regenerate instead.

## bridge-adapter (`BridgeError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `BridgePaused` | Bridge is paused and operations are not allowed. |
| 2 | `InvalidAmount` | Amount is outside the allowed range (min/max). |
| 3 | `UnsupportedChain` | Destination chain is not supported. |
| 4 | `OperationNotFound` | Operation not found. |
| 5 | `AlreadyProcessed` | Operation has already been processed. |
| 6 | `AmountMismatch` | Amount mismatch between operations. |
| 7 | `ChainMismatch` | Chain identifier mismatch. |
| 8 | `InvalidRecipient` | Invalid recipient address. |
| 9 | `InsufficientBalance` | Insufficient balance for operation. |
| 10 | `InvalidSignature` | Signature verification failed. |
| 11 | `NotInitialized` | Bridge is not initialized. |
| 12 | `Unauthorized` | Unauthorized access (not admin). |
| 13 | `OperationTimeout` | Operation timeout. |
| 14 | `InvalidAsset` | Invalid asset identifier. |

## escrow (`EscrowError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `AlreadyInitialized` | Contract has already been initialized. |
| 2 | `NotInitialized` | Contract has not been initialized yet. |
| 3 | `InvalidAmount` | Deposit amount must be greater than zero. |
| 4 | `AlreadyReleased` | Borrower has already completed their savings and funds were released. |
| 5 | `AlreadyWithdrawn` | Borrower has already withdrawn. |
| 6 | `TargetNotReached` | Savings target has not been reached yet. |
| 7 | `Unauthorized` | Only the admin can call this function. |
| 8 | `PeriodExpired` | The savings period has expired. |
| 9 | `BorrowerNotFound` | Borrower record not found. |
| 10 | `AlreadySeized` | Collateral has already been seized. |
| 11 | `UpgradeNotPending` | No pending upgrade exists to execute. |
| 12 | `UpgradeTimelockActive` | Upgrade was proposed but the timelock delay has not elapsed yet. |
| 13 | `GracePeriodActive` | The borrower's grace period has not yet expired; removal is not allowed. |
| 14 | `BorrowerNotInDefault` | The borrower is not in default and cannot be forcibly removed. |
| 15 | `ContractPaused` | Operation rejected because the contract is paused. |
| 16 | `NotPendingAdmin` | Proposed new admin is not the caller or no transfer is pending. |
| 17 | `BridgeFailed` | Cross-contract bridge call to the lending pool failed. |
| 18 | `LockupNotMet` | Minimum savings lockup period has not elapsed yet. |
| 19 | `InvalidPenaltyBps` | Penalty tier values must be within basis-points bounds. |
| 20 | `ReentrancyGuard` | Reentrant call detected — mutating function already in progress. |
| 21 | `InvalidTtlConfig` | TTL bump amounts and lifetime thresholds must be greater than zero. |
| 22 | `PenaltyProposalNotPending` | Penalty proposal is not pending. |
| 23 | `EscrowGoalNotFound` | Escrow goal does not exist or has no deposits. |
| 24 | `AddressNotWhitelisted` | Address is not whitelisted when permissioned mode is enabled. |
| 25 | `InvalidAttestorConfig` | Attestor signer set is empty, has a duplicate, or the threshold is zero or exceeds the number of signers. |
| 26 | `InvalidAttestation` | An attestor is not part of the configured signer set, or the same attestor was presented more than once, or no attestor config exists. |
| 27 | `UnauthorizedBeneficiary` | Caller is not the designated beneficiary, or the designation target equals the owner itself. |
| 28 | `InvalidInactivityPeriod` | Beneficiary inactivity period is zero or exceeds the configured storage TTL bump amounts. |
| 29 | `BeneficiaryNotConfigured` | No beneficiary is designated for this borrower/goal escrow. |
| 30 | `BeneficiaryAlreadyClaimed` | The beneficiary has already claimed this borrower/goal escrow. |
| 31 | `NoClaimableFunds` | Escrow has no deposited balance, or is already released, withdrawn, or seized, so there is nothing for a beneficiary to claim. |
| 32 | `BeneficiaryInactivityNotElapsed` | The owner inactivity period has not yet elapsed. |
| 33 | `InsufficientAttestationQuorum` | Fewer approved attestations than the configured quorum threshold. |
| 34 | `AutoDepositNotConfigured` | No auto-deposit schedule is configured for this borrower/goal escrow. |
| 35 | `AutoDepositNotDue` | The auto-deposit interval has not elapsed since the last scheduled draw. |
| 36 | `InsufficientAllowance` | The borrower's token allowance to the escrow is below the scheduled amount. |
| 37 | `InsufficientBalance` | The borrower's token balance is below the scheduled amount. |
| 38 | `InvalidAutoDepositInterval` | Auto-deposit interval must be greater than zero ledgers. |

## lending-pool (`PoolError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `AlreadyInitialized` | Contract has already been initialized. |
| 2 | `NotInitialized` | Contract has not been initialized yet. |
| 3 | `InvalidAmount` | Amount must be greater than zero. |
| 4 | `Unauthorized` | Only the admin can perform this action. |
| 5 | `InsufficientBalance` | Investor has insufficient balance to withdraw. |
| 6 | `LoanAlreadyExists` | Loan with this ID already exists. |
| 7 | `LoanNotFound` | Loan not found. |
| 8 | `InvalidLoanState` | Loan is not in the correct state for this operation. |
| 9 | `InsufficientLiquidity` | Insufficient pool liquidity for the requested disbursement. |
| 10 | `OverPayment` | Repayment exceeds remaining loan balance. |
| 11 | `NotEligibleForDefault` | Loan has not met the criteria for default. |
| 12 | `AlreadyDefaulted` | Loan has already defaulted. |
| 13 | `ContractPaused` | Operation rejected because the contract is paused. |
| 14 | `NotPendingAdmin` | Proposed new admin is not the caller or no transfer is pending. |
| 15 | `UpgradeNotPending` | No pending upgrade exists to execute. |
| 16 | `UpgradeTimelockActive` | Upgrade was proposed but the timelock delay has not elapsed yet. |
| 17 | `TrancheMismatch` | Investor cannot change tranche after the initial deposit. |
| 18 | `InsufficientJuniorCapital` | Junior tranche has insufficient capital to absorb this loss. |
| 19 | `ApplicantNotVerified` | Borrower has no valid, non-expired verification record in the configured VerificationRegistry, so the loan request is rejected. |
| 20 | `DailyBorrowLimitExceeded` | The daily borrow limit has been exceeded. |
| 21 | `RefundExceedsDisbursed` | Refund amount exceeds the amount disbursed for the loan. |
| 22 | `UnauthorizedContractor` | Disbursement recipient is not a whitelisted contractor. |
| 23 | `InsufficientPaymentHistory` | Refinancing requires at least 3 successful payments. |
| 24 | `InterestRateTooLow` | Interest rate for refinancing is below the allowed floor. |
| 25 | `RefinanceNotEligible` | Loan cannot be refinanced. |
| 26 | `LoanNotOverdue` | Loan is not yet overdue, so it cannot be marked as defaulted. |
| 27 | `OracleUnavailable` | Oracle data is stale or unavailable. |
| 28 | `OraclePriceInvalid` | Oracle price is zero or invalid. |
| 29 | `LtvExceeded` | Requested loan exceeds the configured maximum LTV. |
| 30 | `ReferralCycleDetected` | Referral relationships cannot contain cycles. |
| 31 | `ReferralAlreadySet` | Referral relationship already exists. |
| 32 | `RebateAlreadyClaimed` | Loan maturity rebate has already been claimed. |
| 33 | `MissedPaymentsPreventRebate` | Loan has missed payments, so is ineligible for the maturity rebate. |
| 34 | `NoRestructureProposal` | No pending restructure proposal for this loan. |
| 35 | `MultisigValidatorNotSet` | MultisigValidator contract address has not been configured. |
| 36 | `LockupPeriodActive` | Investor withdrawal is blocked because the lockup period has not elapsed. |
| 37 | `LoanNotActive` | Loan must be in Approved state for this operation. |
| 38 | `RestructureProposalExists` | A restructure proposal already exists for this loan. |
| 39 | `FeeSwitchTooHigh` | Proposed fee switch exceeds the hard protocol cap. |
| 40 | `DepositBelowMinimum` | Deposit is below the pool's configured minimum deposit amount. |
| 41 | `CollateralRatioBreached` | Collateral release would breach the minimum collateralization ratio. |
| 42 | `NoCollateralToRelease` | No collateral available for release. |
| 45 | `OriginationFeeTooHigh` | Origination fee exceeds the full-disbursement ceiling. |
| 46 | `BorrowerLoanCapExceeded` | Borrower already holds the maximum number of active loans permitted by `max_active_loans_per_borrower`. |
| 50 | `WithdrawalExceedsMaxSingleLimit` | Withdrawal amount exceeds the pool's configured per-transaction limit. |
| 51 | `AddressNotWhitelisted` | Address is not whitelisted when permissioned mode is enabled. |
| 52 | `RefinanceCooldownActive` | Refinancing request was submitted before the cooldown window elapsed. |

## lending-pool (`LoanAssumptionError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `ContractPaused` | Operation rejected because the contract is paused. |
| 2 | `LoanNotFound` | Loan not found. |
| 3 | `LoanNotActive` | Loan must be in Approved state for this operation. |
| 4 | `ApplicantNotVerified` | Borrower has no valid, non-expired verification record in the configured VerificationRegistry, so the loan request is rejected. |
| 5 | `AssumptionAlreadyRequested` | A loan assumption request already exists for this loan. |
| 6 | `AssumptionNotFound` | No pending loan assumption request found for this loan. |
| 7 | `AssumptionNotAuthorized` | Loan assumption is not authorized by borrower or new borrower. |

## milestone (`MilestoneError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `AlreadyInitialized` | Contract has already been initialized. |
| 2 | `NotInitialized` | Contract has not been initialized yet. |
| 3 | `Unauthorized` | Caller is not authorized to perform the action. |
| 4 | `InvalidAmount` | Amount must be greater than zero. |
| 5 | `MilestoneNotFound` | Milestone not found. |
| 6 | `InvalidStatus` | Invalid milestone status for the requested action. |
| 7 | `EvidenceRequired` | Evidence hash is required for milestone proposal. |
| 8 | `MilestoneExists` | A milestone with this proposal ID already exists. |
| 9 | `AlreadyVoted` | This approver has already voted on the proposal. |
| 10 | `InvalidThreshold` | Approver set must be non-empty and threshold within 1..=approvers. |
| 11 | `InvalidCidFormat` | Provided IPFS CID does not match v0 (46-char "Qm…") or v1 (59-char "bafy…") format. |
| 12 | `TimelockNotElapsed` | The minimum timelock between approval and release has not elapsed yet. |
| 13 | `AlreadyDisputed` | Milestone is already disputed and cannot be disputed again. |
| 14 | `CannotDispute` | Milestone cannot be disputed in its current status (only Approved/Disbursed). |
| 15 | `RefundFailed` | Refund operation failed (cross-contract call to lending pool). |
| 16 | `SelfDealingNotAllowed` | Contractor cannot also be the borrower for the same loan. |
| 17 | `ReentrancyGuard` | Reentrancy guard is already set. |
| 18 | `BudgetChangeNotFound` | Budget change proposal not found. |
| 19 | `BudgetChangeAlreadyExecuted` | Budget change proposal has already been executed. |
| 20 | `BudgetChangeExceedsAllotment` | New budget exceeds the available loan allotment. |

## multisig-validator (`ValidatorError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `AccountNotConfigured` | No signer configuration exists for the requested account. |
| 2 | `AccountAlreadyConfigured` | A configuration already exists for the account. |
| 3 | `InvalidThreshold` | Threshold must be > 0 and <= the total configurable signer weight. |
| 4 | `InvalidWeight` | A signer weight of zero is not allowed. |
| 5 | `DuplicateSigner` | The signer set contains a duplicate key. |
| 6 | `UnknownSigner` | A presented signer is not part of the account's configured signer set. |
| 7 | `InsufficientWeight` | The cumulative weight of the presented signers is below the threshold. |
| 8 | `NoSigners` | The signer set is empty. |
| 9 | `ProposalNotFound` | No proposal exists for the given ID. |
| 10 | `ProposalAlreadyExecuted` | The proposal has already been executed. |
| 11 | `TimelockNotElapsed` | The timelock delay has not yet elapsed. |
| 12 | `TimelockNotConfigured` | No timelock has been configured for this account. |
| 13 | `NotYetApproved` | The approval period has not yet been reached. |
| 14 | `AdminNotSet` | No admin has been initialized for the admin-managed signer set. |
| 15 | `AdminAlreadySet` | An admin has already been initialized. |
| 16 | `SignerAlreadyExists` | The address is already a configured admin-managed signer. |
| 17 | `SignerNotFound` | The address is not a configured admin-managed signer. |
| 18 | `AdminConfigNotSet` | The admin-managed signer set has not been configured. |
| 19 | `ProposalExpired` | The proposal has expired (current ledger past expiration_ledger). |
| 20 | `SignerPenalized` | Signer is penalized for repeated missed votes (weight reduced). |

## verification-registry (`RegistryError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `AlreadyInitialized` | Contract has already been initialized. |
| 2 | `NotInitialized` | Contract has not been initialized yet. |
| 3 | `Unauthorized` | Caller is not authorized to perform the action. |
| 4 | `InvalidDuration` | Verification duration must be greater than zero. |
| 5 | `InvalidHash` | Report hash must not be empty/zeroed. |
| 6 | `VerificationNotFound` | No verification record found for the borrower. |
| 7 | `NoProposedAdmin` | No pending admin proposal exists to accept. |
| 8 | `InvalidScore` | Score must be in the range 0–100 inclusive. |
| 9 | `UnauthorizedPool` | Repayment callback may only be pushed by the configured lending pool. |
| 10 | `InvalidRiskTransition` | Referral or risk state update would create an invalid cycle. |
| 11 | `InvalidRateLimits` | Rate cap/floor values are invalid (floor > cap or cap > 10000). |
| 12 | `InvalidDecayConfig` | Decay parameters are invalid (zero period, or scores out of range). |
