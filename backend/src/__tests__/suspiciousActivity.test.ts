import { evaluateSuspiciousActivity, type ActivityTransaction, type SuspiciousActivityConfig } from "../services/suspiciousActivity.js";

const config: SuspiciousActivityConfig = {
  structuringThreshold: 1_000n,
  structuringCount: 3,
  windowHours: 24,
  rapidCycleHours: 6,
  velocityMultiplier: 3,
  velocityMinimumTransactions: 5,
};

const tx = (id: string, kind: ActivityTransaction["kind"], amount: bigint, hoursAgo: number): ActivityTransaction => ({
  id, kind, amount, ledger: Number(id.replace(/\D/g, "")) || 1, createdAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
});

describe("suspicious activity rules", () => {
  it("flags structuring only after the configured count", () => {
    const findings = evaluateSuspiciousActivity([
      tx("d1", "deposit", 850n, 1), tx("d2", "deposit", 900n, 2), tx("d3", "deposit", 950n, 3),
    ], config);
    expect(findings.map((finding) => finding.code)).toContain("STRUCTURING");
    expect(evaluateSuspiciousActivity([tx("d1", "deposit", 850n, 1), tx("d2", "deposit", 900n, 2)], config)).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: "STRUCTURING" })]));
  });

  it("flags a rapid deposit/withdrawal cycle but not an old withdrawal", () => {
    const findings = evaluateSuspiciousActivity([tx("d1", "deposit", 500n, 5), tx("w1", "withdrawal", 500n, 2)], config);
    expect(findings.map((finding) => finding.code)).toContain("RAPID_CYCLE");
    expect(evaluateSuspiciousActivity([tx("d1", "deposit", 500n, 10), tx("w1", "withdrawal", 500n, 1)], config).map((finding) => finding.code)).not.toContain("RAPID_CYCLE");
  });

  it("does not flag normal low-volume activity", () => {
    const findings = evaluateSuspiciousActivity([tx("d1", "deposit", 100n, 1), tx("w1", "withdrawal", 20n, 20)], config);
    expect(findings).toHaveLength(0);
  });
});
