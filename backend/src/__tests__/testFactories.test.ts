// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import fs from "fs";
import path from "path";
import { StrKey } from "@stellar/stellar-sdk";
import {
  applicantFactory,
  loanFactory,
  loanRowFactory,
  milestoneProposalFactory,
  resetFactorySequences,
  stellarAddress,
  FACTORY_EPOCH,
} from "../test-utils/factories/index.js";

beforeEach(() => resetFactorySequences());

describe("builder", () => {
  it("creates an entity in one call with targeted overrides", () => {
    const loan = loanFactory.build({ amount: "9000", status: "Approved" });
    expect(loan).toMatchObject({ id: "loan-1", amount: "9000", status: "Approved", version: 1 });
  });

  it("is immutable: fluent calls never mutate the shared factory", () => {
    const base = loanFactory.with({ amount: "1" });
    base.with({ amount: "2" });
    expect(base.build().amount).toBe("1");
    expect(loanFactory.build().amount).toBe("1500");
  });

  it("applies overrides in order, with build() overrides last", () => {
    const loan = loanFactory.with({ amount: "1" }).with({ amount: "2" }).build({ amount: "3" });
    expect(loan.amount).toBe("3");
  });

  it("deep-merges nested overrides without dropping sibling fields", () => {
    const row = loanRowFactory.build({ applicant: { verificationStatus: "INELIGIBLE" } });
    expect(row.applicant.verificationStatus).toBe("INELIGIBLE");
    expect(row.applicant.stellarAddress).toMatch(/^G/);
  });

  it("buildMany yields unique ids and supports per-index overrides", () => {
    const loans = loanFactory.buildMany(3, (i) => ({ amount: String((i + 1) * 100) }));
    expect(loans.map((l) => l.id)).toEqual(["loan-1", "loan-2", "loan-3"]);
    expect(loans.map((l) => l.amount)).toEqual(["100", "200", "300"]);
  });

  it("resets sequences for deterministic ids", () => {
    loanFactory.build();
    resetFactorySequences();
    expect(loanFactory.build().id).toBe("loan-1");
  });
});

describe("stellarAddress", () => {
  it("produces checksum-valid, unique public keys", () => {
    const keys = [1, 2, 3, 1000].map(stellarAddress);
    for (const key of keys) expect(StrKey.isValidEd25519PublicKey(key)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("named variants", () => {
  it("verified applicant", () => {
    const applicant = applicantFactory.verified().build();
    expect(applicant.verificationStatus).toBe("ELIGIBLE");
    expect(applicant.creditScore).toBeGreaterThan(0);
    expect(StrKey.isValidEd25519PublicKey(applicant.stellarAddress)).toBe(true);
  });

  it("ineligible, pending and deleted applicants", () => {
    expect(applicantFactory.ineligible().build().verificationStatus).toBe("INELIGIBLE");
    expect(applicantFactory.pending().build().verificationStatus).toBe("PENDING");
    expect(applicantFactory.deleted().build().deletedAt).toEqual(FACTORY_EPOCH);
  });

  it("applicant snapshot honours queued and explicit overrides", () => {
    expect(applicantFactory.verified().with({ creditScore: 580 }).snapshot({ monthlyIncome: 99 })).toEqual({
      verificationStatus: "ELIGIBLE",
      creditScore: 580,
      monthlyIncome: 99,
    });
  });

  it("overdue loan is repaying, past due, with a late fee and grace window", () => {
    const loan = loanRowFactory.overdue(10).build();
    expect(loan.status).toBe("Repaying");
    expect(loan.dueDate!.getTime()).toBeLessThan(FACTORY_EPOCH.getTime());
    expect(loan.missedPayments).toBe(1);
    expect(loan.lateFeeBalance).toBeGreaterThan(0);
    expect(loan.gracePeriodEndsAt!.getTime()).toBeGreaterThan(loan.dueDate!.getTime());
  });

  it("loan row links to its applicant and can be re-pointed", () => {
    const row = loanRowFactory.build();
    expect(row.applicantId).toBe(row.applicant.id);
    const other = applicantFactory.ineligible().build();
    const repointed = loanRowFactory.forApplicant(other).build();
    expect(repointed.applicantId).toBe(other.id);
    expect(repointed.applicant.verificationStatus).toBe("INELIGIBLE");
  });

  it("API loan status variants", () => {
    expect(loanFactory.draft().build().status).toBe("Draft");
    expect(loanFactory.approved().build().status).toBe("Approved");
    expect(loanFactory.rejected().build()).toMatchObject({ status: "Rejected" });
    expect(loanFactory.manualReview().build()).toMatchObject({
      status: "MANUAL_REVIEW",
      manualReviewReason: "DUPLICATE_TAX_ID",
    });
  });

  it("approved milestone is a passed proposal", () => {
    const m = milestoneProposalFactory.approved().build();
    expect(m.status).toBe("Passed");
    expect(Date.parse(m.updatedAt)).toBeGreaterThan(Date.parse(m.createdAt));
    expect(milestoneProposalFactory.rejected().build().reason).toBeTruthy();
  });
});

// ── Schema drift: a model change must surface here, in the factory ──────────

const SCHEMA = fs.readFileSync(path.resolve(__dirname, "../../prisma/schema.prisma"), "utf8");

function modelFields(model: string): Map<string, { required: boolean; scalar: boolean }> {
  const block = SCHEMA.match(new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m"));
  if (!block) throw new Error(`model ${model} not found in schema.prisma`);
  const scalars = new Set(["String", "Int", "Float", "Boolean", "DateTime", "Json", "BigInt", "Decimal"]);
  const enums = new Set([...SCHEMA.matchAll(/^enum (\w+)/gm)].map((m) => m[1]));
  const fields = new Map<string, { required: boolean; scalar: boolean }>();
  for (const line of block[1].split("\n")) {
    const m = line.match(/^\s+(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/);
    if (!m || line.trim().startsWith("//") || line.trim().startsWith("@@")) continue;
    const [, name, type, list, optional, rest] = m;
    const scalar = (scalars.has(type) || enums.has(type)) && !list;
    const hasDefault = /@default|@updatedAt/.test(rest);
    fields.set(name, { scalar, required: scalar && !optional && !hasDefault });
  }
  return fields;
}

describe.each([
  ["Applicant", () => applicantFactory.build()],
  ["LoanApplication", () => loanRowFactory.build()],
])("%s factory vs schema.prisma", (model, make) => {
  const fields = modelFields(model);
  const built = make() as Record<string, unknown>;

  it("only sets fields that exist on the model", () => {
    const unknown = Object.keys(built).filter((key) => !fields.has(key));
    expect(unknown).toEqual([]);
  });

  it("sets every required field that has no database default", () => {
    const missing = [...fields]
      .filter(([name, f]) => f.required && !(name in built))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });
});
