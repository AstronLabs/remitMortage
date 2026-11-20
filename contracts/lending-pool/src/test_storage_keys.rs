// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

//! Storage key collision test for the `lending-pool` contract.
//!
//! Lists every storage key variant and fails if two of them serialize to the
//! same key, or if a variant is added to a key enum without being listed here.
//! See `storage_key_check.rs` (workspace `contracts/` directory) for the checks.

#![cfg(test)]
#![allow(unused_imports, unused_variables)]

use crate::storage_key_check::{assert_storage_keys, key_cases};
use crate::types::{DataKey, FeatureKey, PauseGroup, Tranche};
use soroban_sdk::{testutils::Address as _, Address, BytesN, Env, Symbol};

#[test]
fn test_storage_keys_do_not_collide() {
    let env = Env::default();
    let a = Address::generate(&env);
    let b = Address::generate(&env);
    let sym = Symbol::new(&env, "sample");
    let id = BytesN::from_array(&env, &[7u8; 32]);

    let mut cases = key_cases!(&env, DataKey;
        Config,
        Investor(a.clone()),
        DebtBalance(a.clone(), Tranche::Senior),
        DebtTotalSupply(Tranche::Senior),
        TotalLiquidity,
        Loan(id.clone()),
        LoanSchedule(id.clone()),
        LoanCount,
        SeniorTranche,
        JuniorTranche,
        TotalRepaidInterest,
        TotalDefaultedLoss,
        DefaultedLoanCount,
        ActiveLoanCommitments,
        TotalDeposited,
        Version,
        PendingUpgrade,
        UpgradeDelay,
        Paused,
        PendingAdmin,
        TotalWithdrawalFees,
        EscrowRelationshipStart(a.clone()),
        TotalPrepaymentPenalties,
        ApplicationFee(id.clone()),
        TotalApplicationFees,
        TotalProtocolFees,
        VerificationRegistry,
        InsurancePool,
        TotalInsurancePremiums,
        DailyBorrowLimit,
        DailyBorrowed(7u32),
        GracePeriodLedgers,
        DailyPenaltyBps,
        Whitelist(a.clone()),
        ReentrancyGuard,
        RestructureProposal(id.clone()),
        MultisigValidator,
        HalvingInterval,
        LastHalvingLedger,
        HalvingEpoch,
        BorrowerLifetimeInterest(a.clone()),
        BorrowerActiveLoans(a.clone()),
        LoanRebateClaimed(id.clone()),
        LoanCollateral(id.clone()),
        LoanSymbolMap(sym.clone()),
        LoanAssumption(id.clone()),
        PayoffQuote(id.clone()),
    );
    cases.extend(key_cases!(&env, FeatureKey;
        WaterfallOrder,
        InvestorLastDeposit(a.clone()),
        RefinanceRateLock(id.clone()),
        RefinanceFeeConfig,
        GovernanceContract,
        TotalEmergencyInjected,
        KeeperRewardBps,
        KeeperRewardCap,
        BorrowerExposure(a.clone()),
        MaxBorrowerExposure,
        MaxBorrowerExposureBps,
        FunctionPaused(PauseGroup::Deposits),
        CreditLine(a.clone()),
        InvestorLockup(a.clone()),
        LockupBonusPool,
        LockupBonusFeeShareBps,
        LoanExtensionCount(id.clone()),
        MaxExtensionsPerLoan,
        MaxExtensionMonths,
        ExtensionFeeBps,
        LoanInterestOnly(id.clone()),
        MaxInterestOnlyMonths,
        TrancheDepositCap(Tranche::Senior),
        InvestorDepositCap,
        PendingTrancheCap(Tranche::Senior),
        PendingInvestorCap,
        DepositCapChangeDelay,
        LateFeeCapAbs,
        LateFeeCapBps,
        AssumptionFeeBps,
        YieldMode(a.clone()),
        AssetClassHaircut(sym.clone()),
        PendingHaircutChange(sym.clone()),
        HaircutChangeDelay,
        WindDownStatus,
        PendingWindDown,
        WindDownDelay,
        LoanOriginTerms(id.clone()),
        DailyRepaymentCap,
        BorrowerDailyRepaid(a.clone()),
        MaxInvestorTrancheShareBps,
        RateAdjustPeriodicCapBps,
        RateAdjustLifetimeCapBps,
        LateFeeLifetimeCapBps,
        LoanLateFeesCharged(id.clone()),
        WithdrawalGraceLedgers,
        InvestorDepositLots(a.clone()),
        LoanNoteHash(id.clone()),
        UtilizationPauseThresholdBps,
        UtilizationAutoPaused,
    ));

    let types_src = include_str!("types.rs");
    assert_storage_keys(
        "lending-pool",
        &[("DataKey", types_src), ("FeatureKey", types_src)],
        &cases,
    );
}
