// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const THEME_STORAGE_KEY = "remitmortgage-theme";
const PALETTE_STORAGE_KEY = "remitmortgage-palette";

export type Theme = "light" | "dark";
export type ColorPalette = "default" | "colorblind";

export interface ThemeConfig {
  theme: Theme;
  palette: ColorPalette;
}

// ── Theme (light/dark) ────────────────────────────────────────────────────────

export function getStoredTheme(): Theme | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return null;
}

export function getSystemTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function resolveTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme();
}

export function persistTheme(t: Theme) {
  localStorage.setItem(THEME_STORAGE_KEY, t);
}

// ── Color Palette (default/colorblind) ────────────────────────────────────────

export function getStoredPalette(): ColorPalette | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
  if (stored === "default" || stored === "colorblind") return stored;
  return null;
}

export function resolvePalette(): ColorPalette {
  return getStoredPalette() ?? "default";
}

export function persistPalette(p: ColorPalette) {
  localStorage.setItem(PALETTE_STORAGE_KEY, p);
}

// ── Combined Theme Config ──────────────────────────────────────────────────────

export function resolveThemeConfig(): ThemeConfig {
  return {
    theme: resolveTheme(),
    palette: resolvePalette(),
  };
}

export function applyThemeConfig(config: ThemeConfig) {
  document.documentElement.setAttribute("data-theme", config.theme);
  document.documentElement.setAttribute("data-palette", config.palette);
}

export function persistThemeConfig(config: ThemeConfig) {
  persistTheme(config.theme);
  persistPalette(config.palette);
}

// ── Legacy compatibility ───────────────────────────────────────────────────────

export function applyTheme(t: Theme) {
  applyThemeConfig({ theme: t, palette: resolvePalette() });
}
