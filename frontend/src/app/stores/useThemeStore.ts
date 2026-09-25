// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { create } from "zustand";
import type { Theme, ColorPalette, ThemeConfig } from "../lib/theme";
import { resolveThemeConfig, applyThemeConfig, persistThemeConfig } from "../lib/theme";

interface ThemeState {
  theme: Theme;
  palette: ColorPalette;
  setTheme: (t: Theme) => void;
  setPalette: (p: ColorPalette) => void;
  setThemeConfig: (config: ThemeConfig) => void;
  toggleTheme: () => void;
  togglePalette: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => {
  const initialConfig = resolveThemeConfig();
  
  return {
    theme: initialConfig.theme,
    palette: initialConfig.palette,
    
    setTheme: (t: Theme) => {
      const config = { ...get(), theme: t };
      applyThemeConfig(config);
      persistThemeConfig(config);
      set({ theme: t });
    },
    
    setPalette: (p: ColorPalette) => {
      const config = { ...get(), palette: p };
      applyThemeConfig(config);
      persistThemeConfig(config);
      set({ palette: p });
    },
    
    setThemeConfig: (config: ThemeConfig) => {
      applyThemeConfig(config);
      persistThemeConfig(config);
      set(config);
    },
    
    toggleTheme: () => {
      const { theme, palette } = get();
      const next = theme === "dark" ? "light" : "dark";
      const config = { theme: next, palette };
      applyThemeConfig(config);
      persistThemeConfig(config);
      set({ theme: next });
    },
    
    togglePalette: () => {
      const { theme, palette } = get();
      const next = palette === "default" ? "colorblind" : "default";
      const config = { theme, palette: next };
      applyThemeConfig(config);
      persistThemeConfig(config);
      set({ palette: next });
    },
  };
});
