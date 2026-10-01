// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  computeConcentrationMetrics,
  isOccurrenceDismissed,
  dismissOccurrence,
  DEFAULT_CONCENTRATION_THRESHOLD,
  type TrancheHolding,
} from "../investorRebalancing";

describe("Investor Auto-Diversification Rebalancing", () => {
  class MockStorage implements Storage {
    private store: Record<string, string> = {};
    get length() {
      return Object.keys(this.store).length;
    }
    clear(): void {
      this.store = {};
    }
    getItem(key: string): string | null {
      return this.store[key] ?? null;
    }
    key(index: number): string | null {
      return Object.keys(this.store)[index] ?? null;
    }
    removeItem(key: string): void {
      delete this.store[key];
    }
    setItem(key: string, value: string): void {
      this.store[key] = value;
    }
  }

  describe("computeConcentrationMetrics", () => {
    it("handles empty or zero portfolio holdings gracefully", () => {
      const resultEmpty = computeConcentrationMetrics([]);
      expect(resultEmpty.isOverConcentrated).toBe(false);
      expect(resultEmpty.suggestion).toBeNull();
      expect(resultEmpty.totalPortfolioValue).toBe(0);

      const resultZero = computeConcentrationMetrics([{ tranche: "Senior", amount: 0 }]);
      expect(resultZero.isOverConcentrated).toBe(false);
      expect(resultZero.suggestion).toBeNull();
    });

    it("detects when concentration does NOT exceed threshold", () => {
      const balancedHoldings: TrancheHolding[] = [
        { tranche: "Senior", amount: 6000 },
        { tranche: "Junior", amount: 4000 },
      ];
      // 60% Senior, threshold 70%
      const result = computeConcentrationMetrics(balancedHoldings, 0.7);
      expect(result.isOverConcentrated).toBe(false);
      expect(result.suggestion).toBeNull();
      expect(result.metrics.find((m) => m.tranche === "Senior")?.percentage).toBe(60);
    });

    it("detects when concentration exceeds threshold and generates suggestions", () => {
      const concentratedHoldings: TrancheHolding[] = [
        { tranche: "Senior", amount: 9000 },
        { tranche: "Junior", amount: 1000 },
      ];
      // 90% Senior, threshold 70%
      const result = computeConcentrationMetrics(concentratedHoldings, 0.7, {
        seniorApyBps: 400,
        juniorApyBps: 620,
      });

      expect(result.isOverConcentrated).toBe(true);
      expect(result.suggestion).not.toBeNull();
      expect(result.suggestion?.dominantTranche).toBe("Senior");
      expect(result.suggestion?.concentrationPercentage).toBe(90);

      // Should recommend Junior tranche
      const option = result.suggestion?.options[0];
      expect(option?.targetTranche).toBe("Junior");
      expect(option?.expectedApyBps).toBe(620);
      expect(option?.rationale).toContain("Junior Tranche");
      expect(option?.recommendedAmount).toBeGreaterThan(0);
    });

    it("generates correct recommendation when Junior tranche is concentrated", () => {
      const concentratedJunior: TrancheHolding[] = [
        { tranche: "Junior", amount: 8000 },
        { tranche: "Senior", amount: 2000 },
      ];
      const result = computeConcentrationMetrics(concentratedJunior, 0.75);

      expect(result.isOverConcentrated).toBe(true);
      expect(result.suggestion?.dominantTranche).toBe("Junior");
      expect(result.suggestion?.options[0].targetTranche).toBe("Senior");
      expect(result.suggestion?.options[0].rationale).toContain("Senior Tranche");
    });

    it("respects custom configurable threshold", () => {
      const holdings: TrancheHolding[] = [
        { tranche: "Senior", amount: 5500 },
        { tranche: "Junior", amount: 4500 },
      ];
      // At default 70%, 55% is not over-concentrated
      expect(computeConcentrationMetrics(holdings, DEFAULT_CONCENTRATION_THRESHOLD).isOverConcentrated).toBe(false);

      // At stricter 50% threshold, 55% IS over-concentrated
      const strictResult = computeConcentrationMetrics(holdings, 0.5);
      expect(strictResult.isOverConcentrated).toBe(true);
      expect(strictResult.suggestion?.dominantTranche).toBe("Senior");
    });
  });

  describe("Per-occurrence dismissal logic", () => {
    it("dismisses a specific occurrence without suppressing future concentration events", () => {
      const storage = new MockStorage();

      const initialHoldings: TrancheHolding[] = [
        { tranche: "Senior", amount: 10000 },
      ];
      const result1 = computeConcentrationMetrics(initialHoldings, 0.7);
      const occurrenceId1 = result1.suggestion!.id;

      // Initially not dismissed
      expect(isOccurrenceDismissed(occurrenceId1, storage)).toBe(false);

      // Dismiss occurrence 1
      dismissOccurrence(occurrenceId1, storage);
      expect(isOccurrenceDismissed(occurrenceId1, storage)).toBe(true);

      // A new concentration event occurs when holdings change (e.g. deposit increases)
      const updatedHoldings: TrancheHolding[] = [
        { tranche: "Senior", amount: 25000 },
      ];
      const result2 = computeConcentrationMetrics(updatedHoldings, 0.7);
      const occurrenceId2 = result2.suggestion!.id;

      // Event 1 is dismissed, but Event 2 has a distinct occurrence ID and is NOT suppressed!
      expect(occurrenceId1).not.toBe(occurrenceId2);
      expect(isOccurrenceDismissed(occurrenceId2, storage)).toBe(false);
    });
  });
});
