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
| 15 | `MalformedPayload` | Malformed or truncated inbound bridge message payload. |
| 16 | `UnsupportedVersion` | Unsupported cross-chain message version. |
| 17 | `DailyVolumeCapExceeded` | The mint would push this source chain's rolling daily volume over its configured cap (issue #858). |
| 18 | `CapIncreaseRequiresTimelock` | `set_daily_cap` was asked to raise an existing positive cap — raises must go through propose_daily_cap_increase / execute_daily_cap_increase instead, since only raises are timelocked. |
| 19 | `NoPendingCapIncrease` | No pending cap increase exists for this source chain. |
| 20 | `CapChangeTimelockActive` | A pending cap increase exists but its timelock has not yet elapsed. |

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
| 25 | `BeneficiaryNotConfigured` | Beneficiary has not been configured for this goal. |
| 26 | `UnauthorizedBeneficiary` | Caller is not the designated beneficiary for this goal. |
| 27 | `BeneficiaryInactivityNotElapsed` | The owner-inactivity period has not yet elapsed. |
| 28 | `InsufficientAttestationQuorum` | Not enough valid attestations to satisfy the configured quorum. |
| 29 | `InvalidAttestation` | One or more attestations were invalid or from unknown signers. |
| 30 | `BeneficiaryAlreadyClaimed` | The beneficiary has already claimed this goal. |
| 31 | `NoClaimableFunds` | There are no funds available to claim. |
| 32 | `InvalidInactivityPeriod` | The inactivity period must be greater than zero ledgers. |
| 33 | `InvalidAttestorConfig` | Attestor configuration must have a non-empty signer set and a valid threshold. |
| 34 | `AutoDepositNotConfigured` | No auto-deposit schedule is configured for this borrower/goal escrow. |
| 35 | `AutoDepositNotDue` | The auto-deposit interval has not elapsed since the last scheduled draw. |
| 36 | `InsufficientAllowance` | The borrower's token allowance to the escrow is below the scheduled amount. |
| 37 | `InsufficientBalance` | The borrower's token balance is below the scheduled amount. |
| 38 | `InvalidAutoDepositInterval` | Auto-deposit interval must be greater than zero ledgers. |
| 39 | `InvalidBeneficiaryShares` | Beneficiary split shares do not sum to exactly 10 000 basis points (100 %). |
| 40 | `BeneficiaryListTooLarge` | Beneficiary list exceeds the maximum allowed number of recipients. |
| 41 | `AttestorChangeProposalNotPending` | No pending attestor-threshold change exists to apply or cancel. |
| 42 | `HardshipRequestAlreadyExists` | A hardship withdrawal request already exists for this goal. |
| 43 | `HardshipRequestNotFound` | No hardship withdrawal request exists for this goal. |
| 44 | `HardshipRequestExpired` | The hardship request's approval window has elapsed. |
| 45 | `HardshipRequestNotApproved` | The hardship request has not been approved by the admin yet. |
| 46 | `HardshipAmountExceedsCap` | The hardship withdrawal exceeds the per-period cap. |
| 47 | `ReleaseTimeNotReached` | The goal's confirmed scheduled release time has not been reached yet. |
| 48 | `InvalidReleaseTime` | Proposed release time is in the past, too far out, or moves the confirmed date further than the configured limit allows. |
| 49 | `RescheduleLimitReached` | The goal's release time cannot be rescheduled again: the reschedule count or minimum interval limit was hit, or the date already passed. |
| 50 | `NoPendingReleaseTime` | There is no pending release time proposal to confirm. |

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
| 13 | `ContractPaused` | Operation rejected because the contract is paused. |
| 14 | `NotPendingAdmin` | Proposed new admin is not the caller or no transfer is pending. |
| 16 | `TimelockActive` | A timelocked change (upgrade, haircut, deposit cap, ...) was proposed but its delay has not elapsed yet. |
| 17 | `TrancheMismatch` | Investor cannot change tranche after the initial deposit. |
| 20 | `DailyBorrowLimitExceeded` | The daily borrow limit has been exceeded. |
| 21 | `RefundExceedsDisbursed` | Refund amount exceeds the amount disbursed for the loan. |
| 22 | `UnauthorizedContractor` | Disbursement recipient is not a whitelisted contractor. |
| 23 | `InsufficientPaymentHistory` | Refinancing requires at least 3 successful payments. |
| 24 | `InterestRateTooLow` | Interest rate for refinancing is below the allowed floor. |
| 25 | `RefinanceNotEligible` | Loan cannot be refinanced. |
| 26 | `LoanNotOverdue` | Loan is not yet overdue, so it cannot be marked as defaulted. |
| 32 | `RebateAlreadyClaimed` | Loan maturity rebate has already been claimed. |
| 33 | `LoanNotGoodStanding` | Loan has missed payments, so is ineligible for the maturity rebate or an extension. |
| 34 | `NoRestructureProposal` | No pending restructure proposal for this loan. |
| 35 | `MultisigValidatorNotSet` | MultisigValidator contract address has not been configured. |
| 36 | `LockupPeriodActive` | Investor withdrawal is blocked because the lockup period has not elapsed. |
| 37 | `LoanNotActive` | Loan must be in Approved state for this operation. |
| 38 | `RestructureProposalExists` | A restructure proposal already exists for this loan. |
| 40 | `DepositBelowMinimum` | Deposit is below the pool's configured minimum deposit amount. |
| 41 | `CollateralRatioBreached` | Collateral release would breach the minimum collateralization ratio. |
| 42 | `NoCollateralToRelease` | No collateral available for release. |
| 44 | `InvalidCollateralRatio` | Invalid collateral ratio configuration. |
| 45 | `FeeTooHigh` | A fee (origination, application or protocol fee switch) exceeds its ceiling. |
| 46 | `BorrowerLoanCapExceeded` | Borrower already holds the maximum number of active loans permitted by `max_active_loans_per_borrower`, or the loan would push their aggregate outstanding principal past the configured exposure cap. (The error enum is at Soroban's 50-variant ceiling, so both limits share this code.) |
| 47 | `RefinanceCooldownActive` | Refinancing request was submitted before the cooldown window elapsed. |
| 50 | `WithdrawalExceedsMaxSingleLimit` | Withdrawal amount exceeds the pool's configured per-transaction limit. |
| 51 | `PayoffQuoteNotFound` | No payoff quote exists for this loan. |
| 52 | `PayoffQuoteExpired` | The payoff quote has expired; request a fresh quote. |
| 54 | `DepositCooldownActive` | Deposit attempted before the configured per-investor cooldown has elapsed. |
| 55 | `RefinanceRateLockExpired` | Refinance execution attempted after the rate-lock window has expired. The borrower must call `request_refinance` again to obtain a fresh quote. |
| 57 | `InsurancePoolNotSet` | Emergency liquidity injection requires an InsurancePool to be configured. |
| 58 | `GovernanceContractNotSet` | Emergency liquidity injection requires a GovernanceContract to be configured. |
| 59 | `GovernanceProposalNotPassed` | The referenced governance proposal has not reached `Passed` status. |
| 60 | `EmergencyInjectionCapExceeded` | Injection amount exceeds the configured percentage cap of insurance reserves. |
| 61 | `CreditLineAlreadyExists` | A credit line already exists for this borrower. |
| 62 | `CreditLineNotFound` | No credit line exists for this borrower. |
| 63 | `CreditLimitExceeded` | Draw would exceed the approved credit limit minus the outstanding drawn balance. |
| 64 | `ExtensionCapExceeded` | Loan extension exceeds the permitted count or term. |
| 65 | `TrancheCapExceeded` | Deposit would push the tranche's total past its admin-set cap. |
| 66 | `InvestorCapExceeded` | Deposit would push the investor's position past the admin-set per-investor cap. |

## lending-pool (`LoanAssumptionError`)

| Code | Variant | Description |
|------|---------|-------------|
| 1 | `ContractPaused` |  |
| 2 | `LoanNotFound` |  |
| 3 | `LoanNotActive` |  |
| 4 | `AssumptionNotAuthorized` |  |
| 5 | `ApplicantNotVerified` |  |
| 6 | `AssumptionNotFound` |  |
| 7 | `AssumptionAlreadyRequested` |  |
| 8 | `AssumptionFeeCapExceeded` | The requested loan assumption fee is above the hard on-chain cap. |
| 9 | `NotInitialized` | The pool has not been initialized. |

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
| 21 | `ArbitrationNotConfigured` | Arbitrators and window have not been configured by the admin. |
| 22 | `InvalidArbitrationWindow` | Arbitration window must be greater than zero ledgers. |
| 23 | `DisputeNotFound` | No arbitration dispute exists for this milestone. |
| 24 | `DisputeAlreadyResolved` | The dispute has already been resolved. |
| 25 | `ArbitrationWindowElapsed` | The arbitration window has elapsed; only the timeout resolution applies. |
| 26 | `ArbitrationWindowOpen` | The arbitration window is still open. |
| 27 | `InvalidPartialAmount` | Partial release amount must be greater than zero. |
| 28 | `ExceedsRemainingAmount` | Partial release amount exceeds the milestone's remaining unreleased amount. |
| 29 | `CannotReject` | Milestone cannot be rejected in its current status (only Proposed). |
| 30 | `CannotResubmit` | Milestone cannot be resubmitted in its current status (only Rejected). |
| 31 | `InvalidBonusConfig` | Performance bonus basis points must be within 0..=10000. |
| 32 | `InvalidDeadline` | A milestone deadline must be a future ledger sequence. |

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
| 21 | `RotationCooldownActive` | A signer-set change was attempted before the rotation cooldown elapsed. |
| 22 | `InvalidRotationCooldown` | Invalid rotation cooldown configuration. |
| 23 | `TooManyActions` | The proposal's action list exceeds `MAX_ACTIONS_PER_PROPOSAL`. |
| 24 | `DuplicateActionId` | Two actions within the same proposal share the same `action_id`. |

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
| 13 | `AppealAlreadyOpen` | The borrower already has an open appeal awaiting resolution. |
| 14 | `NoOpenAppeal` | No open appeal exists for the borrower. |
| 15 | `ReviewerNotConfigured` | No reviewer has been configured to resolve score appeals. |
