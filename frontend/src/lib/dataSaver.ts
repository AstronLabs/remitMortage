// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

export const DATA_SAVER_STORAGE_KEY = "remitmortgage-data-saver";
export const HIGH_CONTRAST_STORAGE_KEY = "remitmortgage-high-contrast";

export function getDataSaverDefault(): boolean {
  if (typeof window === "undefined") return false;
  const saved = window.localStorage.getItem(DATA_SAVER_STORAGE_KEY);
  if (saved === "on" || saved === "off") return saved === "on";
  return Boolean(
    (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
  );
}

export function getHighContrastDefault(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(HIGH_CONTRAST_STORAGE_KEY) === "on";
}

export function persistDataSaver(enabled: boolean) {
  if (typeof window !== "undefined")
    window.localStorage.setItem(DATA_SAVER_STORAGE_KEY, enabled ? "on" : "off");
}

export function persistHighContrast(enabled: boolean) {
  if (typeof window !== "undefined")
    window.localStorage.setItem(HIGH_CONTRAST_STORAGE_KEY, enabled ? "on" : "off");
}

export function dataSaverInterval(normalMs: number, saverMs: number, enabled: boolean) {
  return enabled ? saverMs : normalMs;
}
