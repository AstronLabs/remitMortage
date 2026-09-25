// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { create } from "zustand";
import type { Theme } from "../lib/theme";
import { resolveTheme, applyTheme, persistTheme } from "../lib/theme";

interface ThemeState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: resolveTheme(),
  setTheme: (t: Theme) => {
    applyTheme(t);
    persistTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => {
    const next = get().theme === "dark" ? "light" : "dark";
    applyTheme(next);
    persistTheme(next);
    set({ theme: next });
  },
}));
