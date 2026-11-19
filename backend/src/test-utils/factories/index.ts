// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Shared test data factories. Import from here instead of writing entity
 * literals in tests — see docs/TEST_DATA_FACTORIES.md.
 */
export { Builder, mergeOverrides, resetFactorySequences, type DeepPartial } from "./builder.js";
export { stellarAddress } from "./stellar.js";
export {
  applicantFactory,
  ApplicantBuilder,
  FACTORY_EPOCH,
  type ApplicantRow,
  type ApplicantVerificationStatus,
} from "./applicant.js";
export {
  loanFactory,
  loanRowFactory,
  LoanBuilder,
  LoanRowBuilder,
  type LoanApplicationRow,
} from "./loan.js";
export { milestoneProposalFactory, MilestoneProposalBuilder } from "./milestone.js";
