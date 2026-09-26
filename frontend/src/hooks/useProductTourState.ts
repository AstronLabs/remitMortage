"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface ProductTourState {
  completed: boolean;
  dismissed: boolean;
  setCompleted: (completed: boolean) => void;
  setDismissed: (dismissed: boolean) => void;
  reset: () => void;
}

const useProductTourStore = create<ProductTourState>()(
  persist(
    (set) => ({
      completed: false,
      dismissed: false,
      setCompleted: (completed) => set({ completed }),
      setDismissed: (dismissed) => set({ dismissed }),
      reset: () => set({ completed: false, dismissed: false }),
    }),
    {
      name: "product-tour-storage",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

// This makes the Zustand store compatible with server components and prevents hydration errors.
export const useProductTourState = (selector: (state: ProductTourState) => any) => {
  const state = useProductTourStore(selector);
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => {
    setIsHydrated(true);
  }, []);
  return isHydrated ? state : selector(useProductTourStore.getState());
};

export const getProductTourStore = () => useProductTourStore;
