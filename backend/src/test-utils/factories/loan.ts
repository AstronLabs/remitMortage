// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { LoanApplication, LoanStatus } from "../../services/loanStore.js";
import { Builder, createSequence, type Sequence } from "./builder.js";
import { applicantFactory, FACTORY_EPOCH, type ApplicantRow } from "./applicant.js";
import { stellarAddress } from "./stellar.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const GRACE_PERIOD_DAYS = 5;

const apiSequence = createSequence();
const rowSequence = createSequence();

// ── API-level loan (what loanStore returns / routes serialise) ───────────────

export class LoanBuilder extends Builder<LoanApplication> {
  constructor(seq: Sequence = apiSequence) {
    super(
      (n) => ({
        id: `loan-${n}`,
        // Offset keeps loan borrowers distinct from applicant factory addresses.
        borrowerAddress: stellarAddress(10_000 + n),
        amount: "1500",
        status: "Pending",
        createdAt: FACTORY_EPOCH.toISOString(),
        updatedAt: FACTORY_EPOCH.toISOString(),
        version: 1,
      }),
      seq
    );
  }

  private inStatus(status: LoanStatus, extra: Partial<LoanApplication> = {}): this {
    return this.with({ status, ...extra });
  }

  draft(): this {
    return this.inStatus("Draft");
  }
  pending(): this {
    return this.inStatus("Pending");
  }
  approved(): this {
    return this.inStatus("Approved");
  }
  rejected(reason = "Does not meet underwriting criteria"): this {
    return this.inStatus("Rejected", { reason });
  }
  disbursing(): this {
    return this.inStatus("Disbursing", { reason: "funds released" });
  }
  repaying(): this {
    return this.inStatus("Repaying");
  }
  completed(): this {
    return this.inStatus("Completed");
  }
  manualReview(reason = "DUPLICATE_TAX_ID"): this {
    return this.inStatus("MANUAL_REVIEW", { manualReviewReason: reason });
  }
}

export const loanFactory = new LoanBuilder();

// ── Persisted row (what Prisma `loanApplication` queries return) ─────────────

/**
 * A persisted `LoanApplication` row with its applicant. Mirrors
 * `model LoanApplication` in schema.prisma; `factories.schema.test.ts` fails
 * when this drifts from the schema.
 */
export interface LoanApplicationRow {
  id: string;
  applicantId: string;
  applicant: ApplicantRow;
  escrowContractId: string | null;
  loanId: string | null;
  principal: number;
  interestRateBps: number;
  rateSheetVersionId: string | null;
  status: Exclude<LoanStatus, "MANUAL_REVIEW">;
  createdAt: Date;
  version: number;
  dueDate: Date | null;
  missedPayments: number;
  lateFeeBalance: number;
  gracePeriodEndsAt: Date | null;
  statusUpdatedAt: Date;
  lastActivityAt: Date;
  reason: string | null;
  manualReviewReason: string | null;
  deletedAt: Date | null;
}

export class LoanRowBuilder extends Builder<LoanApplicationRow> {
  constructor(seq: Sequence = rowSequence) {
    super((n) => {
      const applicant = applicantFactory.verified().build();
      return {
        id: `loan-row-${n}`,
        applicantId: applicant.id,
        applicant,
        escrowContractId: null,
        loanId: null,
        principal: 1500,
        interestRateBps: 800,
        rateSheetVersionId: null,
        status: "Pending",
        createdAt: FACTORY_EPOCH,
        version: 1,
        dueDate: null,
        missedPayments: 0,
        lateFeeBalance: 0,
        gracePeriodEndsAt: null,
        statusUpdatedAt: FACTORY_EPOCH,
        lastActivityAt: FACTORY_EPOCH,
        reason: null,
        manualReviewReason: null,
        deletedAt: null,
      };
    }, seq);
  }

  /** Attach a specific applicant, keeping `applicantId` consistent. */
  forApplicant(applicant: ApplicantRow): this {
    return this.with({ applicantId: applicant.id, applicant });
  }

  pending(): this {
    return this.with({ status: "Pending" });
  }
  approved(): this {
    return this.with({ status: "Approved" });
  }
  rejected(reason = "Does not meet underwriting criteria"): this {
    return this.with({ status: "Rejected", reason });
  }

  /** Active repayment, next payment due in 30 days. */
  repaying(): this {
    return this.with({
      status: "Repaying",
      dueDate: new Date(FACTORY_EPOCH.getTime() + 30 * DAY_MS),
    });
  }

  /**
   * Repaying and past due as of `FACTORY_EPOCH`: one missed payment, a late
   * fee accrued, and the grace period already running.
   */
  overdue(daysPastDue = 10): this {
    const dueDate = new Date(FACTORY_EPOCH.getTime() - daysPastDue * DAY_MS);
    return this.with({
      status: "Repaying",
      dueDate,
      missedPayments: 1,
      lateFeeBalance: 25,
      gracePeriodEndsAt: new Date(dueDate.getTime() + GRACE_PERIOD_DAYS * DAY_MS),
    });
  }

  completed(): this {
    return this.with({ status: "Completed" });
  }
  softDeleted(): this {
    return this.with({ deletedAt: FACTORY_EPOCH });
  }
}

export const loanRowFactory = new LoanRowBuilder();
