import {
  evaluateApplicantAgainstRules,
  evaluateRule,
  formatAutoRejectionReason,
  type AutoRejectionRuleRecord,
} from "../services/autoRejectionRules.js";

const baseRules: AutoRejectionRuleRecord[] = [
  {
    id: "rule-credit",
    name: "Minimum credit score",
    ruleType: "MIN_CREDIT_SCORE",
    config: { minCreditScore: 620 },
    active: true,
    priority: 1,
  },
  {
    id: "rule-dti",
    name: "Maximum debt-to-income",
    ruleType: "MAX_DEBT_TO_INCOME",
    config: { maxRatio: 0.43 },
    active: true,
    priority: 2,
  },
  {
    id: "rule-verify",
    name: "Requires eligible verification",
    ruleType: "REQUIRES_VERIFICATION",
    config: { requiredStatus: "ELIGIBLE" },
    active: true,
    priority: 3,
  },
];

describe("autoRejectionRules engine", () => {
  it("rejects applicants below the configured minimum credit score", () => {
    const failure = evaluateRule(baseRules[0], {
      verificationStatus: "ELIGIBLE",
      creditScore: 580,
      monthlyIncome: 5000,
    }, 10000);

    expect(failure?.ruleType).toBe("MIN_CREDIT_SCORE");
    expect(failure?.reason).toMatch(/below the minimum required score/i);
  });

  it("rejects applicants exceeding the configured debt-to-income ratio", () => {
    const failure = evaluateRule(baseRules[1], {
      verificationStatus: "ELIGIBLE",
      creditScore: 700,
      monthlyIncome: 1000,
    }, 50000);

    expect(failure?.ruleType).toBe("MAX_DEBT_TO_INCOME");
    expect(failure?.reason).toMatch(/debt-to-income ratio/i);
  });

  it("rejects applicants without eligible verification status", () => {
    const failure = evaluateRule(baseRules[2], {
      verificationStatus: "PENDING",
      creditScore: 720,
      monthlyIncome: 6000,
    }, 10000);

    expect(failure?.ruleType).toBe("REQUIRES_VERIFICATION");
    expect(failure?.reason).toMatch(/Verification status must be ELIGIBLE/i);
  });

  it("evaluates all active rules and aggregates human-readable reasons", () => {
    const result = evaluateApplicantAgainstRules(
      baseRules,
      {
        verificationStatus: "INELIGIBLE",
        creditScore: 500,
        monthlyIncome: 800,
      },
      80000
    );

    expect(result.rejected).toBe(true);
    expect(result.failures.length).toBeGreaterThanOrEqual(2);
    expect(formatAutoRejectionReason(result.failures)).toMatch(/1\./);
  });

  it("passes applicants that satisfy all active rules", () => {
    const result = evaluateApplicantAgainstRules(
      baseRules,
      {
        verificationStatus: "ELIGIBLE",
        creditScore: 720,
        monthlyIncome: 8000,
      },
      10000
    );

    expect(result.rejected).toBe(false);
    expect(result.failures).toHaveLength(0);
  });
});
