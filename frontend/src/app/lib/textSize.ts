// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * User-adjustable text size.
 *
 * The chosen step is applied as a root-level scale: a `data-text-size`
 * attribute on `<html>` drives the root font size in `globals.css`. Because
 * every rem-based size in the app (Tailwind's spacing and typography scales
 * included) is relative to the root font size, one switch scales the whole UI
 * — no per-component overrides.
 */

export const TEXT_SIZE_STORAGE_KEY = "remitmortgage-text-size";

export type TextSize = "default" | "large" | "x-large";

export interface TextSizeStep {
  id: TextSize;
  label: string;
  /** Root font size, as a percentage of the user's browser default. */
  percent: number;
}

/** A small, deliberate set of steps that stay usable at the largest size. */
export const TEXT_SIZE_STEPS: readonly TextSizeStep[] = [
  { id: "default", label: "Default", percent: 100 },
  { id: "large", label: "Large", percent: 112.5 },
  { id: "x-large", label: "Extra large", percent: 125 },
];

export const DEFAULT_TEXT_SIZE: TextSize = "default";

export function isTextSize(value: unknown): value is TextSize {
  return TEXT_SIZE_STEPS.some((step) => step.id === value);
}

export function getStoredTextSize(): TextSize | null {
  if (typeof window === "undefined") return null;
  const stored = localStorage.getItem(TEXT_SIZE_STORAGE_KEY);
  return isTextSize(stored) ? stored : null;
}

export function resolveTextSize(): TextSize {
  return getStoredTextSize() ?? DEFAULT_TEXT_SIZE;
}

/** Apply the scale to the document root. `default` clears the attribute. */
export function applyTextSize(size: TextSize) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (size === DEFAULT_TEXT_SIZE) {
    root.removeAttribute("data-text-size");
  } else {
    root.setAttribute("data-text-size", size);
  }
}

export function persistTextSize(size: TextSize) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TEXT_SIZE_STORAGE_KEY, size);
}
