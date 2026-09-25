"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  createScenario,
  MAX_SCENARIOS,
  scenarioToOnboarding,
  type LoanScenario,
} from "@/lib/loanComparison";
import { getOnboardingStore } from "./useOnboardingState";

interface LoanComparisonState {
  scenarios: LoanScenario[];
  /** Scenario deltas are measured against. */
  baselineId: string | null;
  /** Scenario the borrower committed to, if any. */
  selectedId: string | null;
  addScenario: () => void;
  removeScenario: (id: string) => void;
  updateScenario: (id: string, patch: Partial<LoanScenario>) => void;
  setBaseline: (id: string) => void;
  selectScenario: (id: string) => void;
  reset: () => void;
}

function initialScenarios(): LoanScenario[] {
  return [
    createScenario({ label: "Offer A" }),
    createScenario({ label: "Offer B", interestRateBps: 1_000, termMonths: 24 }),
  ];
}

const useStore = create<LoanComparisonState>()(
  persist(
    (set) => ({
      scenarios: initialScenarios(),
      baselineId: null,
      selectedId: null,

      addScenario: () =>
        set((state) => {
          // Hard cap — the table is designed for three columns.
          if (state.scenarios.length >= MAX_SCENARIOS) return state;
          return {
            scenarios: [
              ...state.scenarios,
              createScenario({
                label: `Offer ${String.fromCharCode(65 + state.scenarios.length)}`,
              }),
            ],
          };
        }),

      removeScenario: (id) =>
        set((state) => {
          // Keep at least one column so the tool never renders empty.
          if (state.scenarios.length <= 1) return state;
          const scenarios = state.scenarios.filter((s) => s.id !== id);
          return {
            scenarios,
            // Drop dangling references to the scenario that just went away.
            baselineId: state.baselineId === id ? null : state.baselineId,
            selectedId: state.selectedId === id ? null : state.selectedId,
          };
        }),

      updateScenario: (id, patch) =>
        set((state) => ({
          scenarios: state.scenarios.map((s) =>
            s.id === id ? { ...s, ...patch } : s
          ),
        })),

      setBaseline: (id) => set({ baselineId: id }),
      selectScenario: (id) => set({ selectedId: id }),
      reset: () =>
        set({ scenarios: initialScenarios(), baselineId: null, selectedId: null }),
    }),
    {
      name: "loan-comparison-storage",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

/**
 * Subscribes to the comparison store without tripping hydration mismatches.
 *
 * The store is persisted to localStorage, which the server cannot see, so the
 * first client render must use the same defaults the server produced and only
 * adopt persisted values once mounted. Mirrors `useOnboardingState`.
 */
export function useLoanComparison<T>(selector: (state: LoanComparisonState) => T): T {
  const value = useStore(selector);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
  }, []);
  return hydrated ? value : selector(useStore.getState());
}

export const getLoanComparisonStore = () => useStore;

/**
 * Copies a scenario's parameters into the onboarding wizard.
 *
 * The wizard reads from its own persisted store, so writing there is what makes
 * the next step open pre-filled. Returns the values applied so the caller can
 * confirm them to the user.
 */
export function applyScenarioToOnboarding(scenario: LoanScenario) {
  const prefill = scenarioToOnboarding(scenario);
  const onboarding = getOnboardingStore().getState();

  onboarding.setSavingsTarget(prefill.savingsTarget);
  onboarding.setSavingsDuration(prefill.savingsDuration);
  onboarding.setFirstDepositAmount(prefill.firstDepositAmount);

  return prefill;
}
