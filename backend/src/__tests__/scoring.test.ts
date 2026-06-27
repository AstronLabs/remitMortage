import { calculateCreditScore } from "../services/scoring";
import { RemittanceAnalysis } from "../services/stellar";

describe("Credit Scoring Engine", () => {
  const baseAnalysis: RemittanceAnalysis = {
    senderAddress: "G_TEST_SENDER",
    recipientAddress: "G_TEST_RECIPIENT",
    totalPayments: 12,
    totalAmountUSDC: "6000",
    averageAmountUSDC: "500",
    standardDeviation: 0,
    spanMonths: 12,
    firstPayment: "2023-01-01",
    lastPayment: "2024-01-01",
    selfDealing: false,
    eligible: true,
    reason: "OK"
  };

  it("Test 1: Excellent tier", () => {
    // 12 payments, 12 months, 6000 total, 0 variance.
    // Consistency (0 stdDev) = 40
    // Frequency (12 months / 11 intervals = ~32 days) = 25
    // Duration (12 months) = 20
    // Volume (6000) = 15
    // Total = 100
    const result = calculateCreditScore(baseAnalysis);
    expect(result.score).toBe(100);
    expect(result.tier).toBe("Excellent");
  });

  it("Test 2: Good tier", () => {
    // 6 payments, 6 months, 2500 total, 0 variance.
    // Consistency = 40
    // Frequency (~36 days) = 15
    // Duration (6 months) = 10
    // Volume (2500) = 10
    // Total = 75
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 6,
      spanMonths: 6,
      totalAmountUSDC: "2500",
      averageAmountUSDC: "416.66"
    });
    expect(result.score).toBe(75);
    expect(result.tier).toBe("Good");
  });

  it("Test 3: Fair tier", () => {
    // 4 payments, 8 months, 600 total, variance high
    // Consistency (stdDev=200, avg=150) -> CV = 1.33 -> 0
    // Frequency (~80 days) = 5
    // Duration (8 months) = 10
    // Volume (600) = 5
    // Total = 20... Wait, Fair is 40-59. Let's adjust.
    // Let's make Consistency = 20 (stdDev = 75, avg = 150)
    // Frequency (~32 days) = 25
    // Duration (3 months) = 5
    // Volume (500) = 5
    // Total = 55 (Fair)
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 4,
      spanMonths: 3,
      totalAmountUSDC: "600",
      averageAmountUSDC: "150",
      standardDeviation: 75
    });
    expect(result.score).toBe(55);
    expect(result.tier).toBe("Fair");
  });

  it("Test 4: Insufficient tier", () => {
    // Volume = 100 (0)
    // Duration = 1 (0)
    // Frequency = 0
    // Total < 39
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 3,
      spanMonths: 3,
      totalAmountUSDC: "100",
      averageAmountUSDC: "33",
      standardDeviation: 33 // CV=1 -> 0
    });
    expect(result.score).toBeLessThan(40);
    expect(result.tier).toBe("Insufficient");
  });

  it("Test 5: Breakdown validation", () => {
    const result = calculateCreditScore(baseAnalysis);
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.consistency).toBe(40);
    expect(result.breakdown.frequency).toBe(25);
    expect(result.breakdown.duration).toBe(20);
    expect(result.breakdown.volume).toBe(15);
  });

  it("Test 6: Edge cases - Single payment", () => {
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalPayments: 1,
    });
    expect(result.score).toBe(0);
    expect(result.tier).toBe("Insufficient");
  });

  it("Test 6: Edge cases - Zero volume", () => {
    const result = calculateCreditScore({
      ...baseAnalysis,
      totalAmountUSDC: "0",
    });
    expect(result.score).toBe(0);
    expect(result.tier).toBe("Insufficient");
  });
});
