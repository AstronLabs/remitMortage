// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { MilestoneProposal } from "../../services/milestoneProposalStore.js";
import { Builder, createSequence, type Sequence } from "./builder.js";
import { FACTORY_EPOCH } from "./applicant.js";

const sequence = createSequence();

export class MilestoneProposalBuilder extends Builder<MilestoneProposal> {
  constructor(seq: Sequence = sequence) {
    super(
      (n) => ({
        id: `proposal-${n}`,
        milestoneId: `milestone-${n}`,
        evidenceCid: `QmEvidence${String(n).padStart(6, "0")}`,
        status: "Open",
        createdAt: FACTORY_EPOCH.toISOString(),
        updatedAt: FACTORY_EPOCH.toISOString(),
      }),
      seq
    );
  }

  /** Awaiting votes. */
  open(): this {
    return this.with({ status: "Open" });
  }

  /** Passed the vote — the milestone counts as approved. */
  approved(): this {
    return this.with({
      status: "Passed",
      updatedAt: new Date(FACTORY_EPOCH.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  rejected(reason = "Evidence did not match the milestone"): this {
    return this.with({ status: "Rejected", reason });
  }
}

export const milestoneProposalFactory = new MilestoneProposalBuilder();
