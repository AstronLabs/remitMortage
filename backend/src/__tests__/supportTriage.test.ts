// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  triageTicket,
  overridePriority,
  applyOverride,
  DEFAULT_TRIAGE_RULES,
  type TriageRule,
  type TicketInput,
} from "../services/supportTriage.js";

// ── Rule matching ──────────────────────────────────────────────────────────

describe("triageTicket – rule matching", () => {
  it("assigns URGENT / urgent-mortgage to a HIGH-tier applicant within 7-day deadline", () => {
    const result = triageTicket({
      id: "ticket-1",
      riskTier: "HIGH",
      daysToDeadline: 5,
    });
    expect(result.priority).toBe("URGENT");
    expect(result.suggestedQueue).toBe("urgent-mortgage");
    expect(result.matchedRuleId).toBe("rule-high-tier-deadline");
  });

  it("assigns HIGH / senior-mortgage to a HIGH-tier applicant outside the deadline window", () => {
    const result = triageTicket({
      id: "ticket-2",
      riskTier: "HIGH",
      daysToDeadline: 30,
    });
    expect(result.priority).toBe("HIGH");
    expect(result.suggestedQueue).toBe("senior-mortgage");
    expect(result.matchedRuleId).toBe("rule-high-tier");
  });

  it("assigns HIGH / senior-mortgage for a large loan nearing its deadline", () => {
    const result = triageTicket({
      id: "ticket-3",
      loanAmount: 750_000,
      daysToDeadline: 10,
    });
    expect(result.priority).toBe("HIGH");
    expect(result.suggestedQueue).toBe("senior-mortgage");
    expect(result.matchedRuleId).toBe("rule-large-loan-deadline");
  });

  it("does not trigger the large-loan rule when loan amount is below the threshold", () => {
    const result = triageTicket({
      id: "ticket-4",
      loanAmount: 200_000,
      daysToDeadline: 10,
    });
    expect(result.matchedRuleId).not.toBe("rule-large-loan-deadline");
  });

  it("assigns NORMAL / standard to a MEDIUM-tier applicant with no deadline pressure", () => {
    const result = triageTicket({
      id: "ticket-5",
      riskTier: "MEDIUM",
    });
    expect(result.priority).toBe("NORMAL");
    expect(result.suggestedQueue).toBe("standard");
  });

  it("falls back to NORMAL / general when no rule matches", () => {
    const result = triageTicket({ id: "ticket-6", riskTier: "LOW" });
    expect(result.priority).toBe("NORMAL");
    expect(result.suggestedQueue).toBe("general");
    expect(result.matchedRuleId).toBeNull();
  });

  it("picks the highest-urgency rule when multiple rules match", () => {
    // HIGH tier + 5-day deadline → both 'rule-high-tier-deadline' (URGENT) and
    // 'rule-high-tier' (HIGH) match; URGENT should win.
    const result = triageTicket({
      id: "ticket-7",
      riskTier: "HIGH",
      daysToDeadline: 5,
    });
    expect(result.priority).toBe("URGENT");
  });

  it("skips inactive rules", () => {
    const customRules: TriageRule[] = [
      {
        id: "rule-inactive",
        name: "Inactive rule",
        riskTier: "HIGH",
        priority: "URGENT",
        suggestedQueue: "urgent-mortgage",
        active: false,
      },
    ];
    const result = triageTicket({ id: "ticket-8", riskTier: "HIGH" }, customRules);
    expect(result.priority).toBe("NORMAL");
    expect(result.matchedRuleId).toBeNull();
  });

  it("attaches an autoTriagedAt timestamp", () => {
    const before = new Date();
    const result = triageTicket({ id: "ticket-9" });
    const after = new Date();
    expect(result.autoTriagedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.autoTriagedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

// ── Priority override auditing ─────────────────────────────────────────────

describe("overridePriority", () => {
  const baseResult = triageTicket({ id: "ticket-10", riskTier: "LOW" });

  it("records the previous and new priority", () => {
    const override = overridePriority(baseResult, "HIGH", "staff-42", "VIP customer escalation");
    expect(override.previousPriority).toBe("NORMAL");
    expect(override.newPriority).toBe("HIGH");
  });

  it("records the staff ID and reason", () => {
    const override = overridePriority(baseResult, "URGENT", "staff-7", "Director request");
    expect(override.staffId).toBe("staff-7");
    expect(override.reason).toBe("Director request");
  });

  it("records an overriddenAt timestamp", () => {
    const before = new Date();
    const override = overridePriority(baseResult, "LOW", "staff-1", "downgrade");
    const after = new Date();
    expect(override.overriddenAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(override.overriddenAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});

describe("applyOverride", () => {
  it("reflects the overridden priority in the effective result", () => {
    const base = triageTicket({ id: "ticket-11", riskTier: "MEDIUM" });
    expect(base.priority).toBe("NORMAL");

    const override = overridePriority(base, "URGENT", "staff-99", "Compliance escalation");
    const effective = applyOverride(base, override);

    expect(effective.priority).toBe("URGENT");
    expect(effective.override.staffId).toBe("staff-99");
    expect(effective.override.reason).toBe("Compliance escalation");
  });

  it("override survives a subsequent auto-triage re-run when re-applied", () => {
    const ticket: TicketInput = { id: "ticket-12", riskTier: "MEDIUM" };

    const firstTriage = triageTicket(ticket);
    const override = overridePriority(firstTriage, "HIGH", "staff-3", "re-review requested");

    // Simulate re-triage (e.g. after new info arrives)
    const reTriage = triageTicket(ticket);
    expect(reTriage.priority).toBe("NORMAL"); // auto-triage unchanged

    // Re-applying the stored override restores the staff decision
    const effective = applyOverride(reTriage, override);
    expect(effective.priority).toBe("HIGH");
    expect(effective.override.reason).toBe("re-review requested");
  });
});
