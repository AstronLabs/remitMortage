// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import type { ApplicantSnapshot } from "../../services/autoRejectionRules.js";
import { Builder, createSequence, type Sequence } from "./builder.js";
import { stellarAddress } from "./stellar.js";

export type ApplicantVerificationStatus = "PENDING" | "ELIGIBLE" | "INELIGIBLE";

/**
 * A persisted `Applicant` row. Mirrors `model Applicant` in schema.prisma;
 * `factories.schema.test.ts` fails when this drifts from the schema.
 */
export interface ApplicantRow {
  id: string;
  stellarAddress: string;
  verificationStatus: ApplicantVerificationStatus;
  creditScore: number | null;
  taxId: string | null;
  taxIdHash: string | null;
  monthlyIncome: string | null;
  displayCurrency: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export const FACTORY_EPOCH = new Date("2026-10-01T00:00:00.000Z");

const sequence = createSequence();

export class ApplicantBuilder extends Builder<ApplicantRow> {
  constructor(seq: Sequence = sequence) {
    super(
      (n) => ({
        id: `applicant-${n}`,
        stellarAddress: stellarAddress(n),
        verificationStatus: "PENDING",
        creditScore: null,
        taxId: null,
        taxIdHash: null,
        monthlyIncome: null,
        displayCurrency: "USD",
        createdAt: FACTORY_EPOCH,
        updatedAt: FACTORY_EPOCH,
        deletedAt: null,
      }),
      seq
    );
  }

  /** Passed identity verification and has a usable credit profile. */
  verified(): this {
    return this.with({ verificationStatus: "ELIGIBLE", creditScore: 720, monthlyIncome: "6000" });
  }

  /** Failed verification. */
  ineligible(): this {
    return this.with({ verificationStatus: "INELIGIBLE", creditScore: 540, monthlyIncome: "1200" });
  }

  /** Awaiting verification (the default state). */
  pending(): this {
    return this.with({ verificationStatus: "PENDING" });
  }

  /** Soft-deleted applicant. */
  deleted(): this {
    return this.with({ deletedAt: FACTORY_EPOCH });
  }

  /**
   * The slimmer shape the auto-rejection engine evaluates. Applies the same
   * queued overrides, so `applicantFactory.verified().with({ creditScore: 580 }).snapshot()`
   * reads as expected.
   */
  snapshot(overrides: Partial<ApplicantSnapshot> = {}): ApplicantSnapshot {
    const row = this.build();
    return {
      verificationStatus: row.verificationStatus,
      creditScore: row.creditScore,
      monthlyIncome: row.monthlyIncome === null ? null : Number(row.monthlyIncome),
      ...overrides,
    };
  }
}

export const applicantFactory = new ApplicantBuilder();
