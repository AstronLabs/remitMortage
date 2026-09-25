"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface OnboardingState {
  step: number;
  recipientAddress: string;
  isVerified: boolean;
  savingsTarget: number;
  savingsDuration: number; // in months
  firstDepositAmount: number;
  setStep: (step: number) => void;
  setRecipientAddress: (address: string) => void;
  setIsVerified: (verified: boolean) => void;
  setSavingsTarget: (target: number) => void;
  setSavingsDuration: (duration: number) => void;
  setFirstDepositAmount: (amount: number) => void;
  reset: () => void;
}

const useOnboardingStore = create<OnboardingState>()(
  persist(
    (set) => ({
      step: 1,
      recipientAddress: "",
      isVerified: false,
      savingsTarget: 10000,
      savingsDuration: 12,
      firstDepositAmount: 0,
      setStep: (step) => set({ step }),
      setRecipientAddress: (address) => set({ recipientAddress: address }),
      setIsVerified: (verified) => set({ isVerified: verified }),
      setSavingsTarget: (target) => set({ savingsTarget: target }),
      setSavingsDuration: (duration) => set({ savingsDuration: duration }),
      setFirstDepositAmount: (amount) => set({ firstDepositAmount: amount }),
      reset: () => set({ step: 1, recipientAddress: "", isVerified: false, firstDepositAmount: 0 }),
    }),
    {
      name: "onboarding-storage",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

// This makes the Zustand store compatible with server components and prevents hydration errors.
export const useOnboardingState = (selector: (state: OnboardingState) => any) => {
  const state = useOnboardingStore(selector);
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    setIsHydrated(true);
  }, []);
  return isHydrated ? state : selector(useOnboardingStore.getState());
};

export const getOnboardingStore = () => useOnboardingStore;
