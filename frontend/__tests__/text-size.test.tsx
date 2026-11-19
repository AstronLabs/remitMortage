// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { act } from "@testing-library/react";
import { runTextSizeBoot } from "../src/app/lib/text-size-boot";
import {
  applyTextSize,
  isTextSize,
  persistTextSize,
  resolveTextSize,
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_STEPS,
  TEXT_SIZE_STORAGE_KEY,
} from "../src/app/lib/textSize";
import { readInitialTextSizeState, useTextSizeStore } from "../src/app/stores/useTextSizeStore";

const html = () => document.documentElement;

// Re-read storage into the store, as a page load would.
function loadFresh() {
  useTextSizeStore.setState(readInitialTextSizeState());
}

function runBoot() {
  runTextSizeBoot();
}

beforeEach(() => {
  localStorage.clear();
  html().removeAttribute("data-text-size");
  loadFresh();
});

describe("pre-paint boot script", () => {
  // The boot script duplicates textSize.ts's resolution logic; this keeps them
  // in agreement so a stored choice is applied identically before first paint.
  it.each(TEXT_SIZE_STEPS.map((step) => step.id))(
    "matches applyTextSize for '%s'",
    (size) => {
      persistTextSize(size);
      applyTextSize(size);
      const expected = html().getAttribute("data-text-size");

      html().removeAttribute("data-text-size");
      runBoot();

      expect(html().getAttribute("data-text-size")).toBe(expected);
    }
  );

  it("applies nothing when the default size is stored (no flash, no stray attribute)", () => {
    persistTextSize(DEFAULT_TEXT_SIZE);
    runBoot();
    expect(html()).not.toHaveAttribute("data-text-size");
  });

  it("survives corrupt storage", () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "gigantic");
    expect(() => runBoot()).not.toThrow();
    expect(html()).not.toHaveAttribute("data-text-size");
  });
});

describe("text-size store", () => {
  it("applies the chosen size to the root and persists it", () => {
    act(() => useTextSizeStore.getState().setTextSize("large"));
    expect(html()).toHaveAttribute("data-text-size", "large");
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe("large");
  });

  it("clears the root attribute when returning to the default size", () => {
    act(() => useTextSizeStore.getState().setTextSize("x-large"));
    expect(html()).toHaveAttribute("data-text-size", "x-large");

    act(() => useTextSizeStore.getState().setTextSize(DEFAULT_TEXT_SIZE));
    expect(html()).not.toHaveAttribute("data-text-size");
    expect(localStorage.getItem(TEXT_SIZE_STORAGE_KEY)).toBe(DEFAULT_TEXT_SIZE);
  });

  it("rehydrates the chosen size on load", () => {
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "x-large");
    loadFresh();
    expect(useTextSizeStore.getState().textSize).toBe("x-large");
  });
});

describe("resolveTextSize", () => {
  it("falls back to the default when nothing valid is stored", () => {
    expect(resolveTextSize()).toBe(DEFAULT_TEXT_SIZE);
    localStorage.setItem(TEXT_SIZE_STORAGE_KEY, "gigantic");
    expect(resolveTextSize()).toBe(DEFAULT_TEXT_SIZE);
  });

  it("recognises only the offered steps", () => {
    expect(isTextSize("large")).toBe(true);
    expect(isTextSize("huge")).toBe(false);
    expect(isTextSize(undefined)).toBe(false);
  });
});
