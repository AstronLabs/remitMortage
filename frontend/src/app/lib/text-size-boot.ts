// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

// Runs before first paint so the chosen text size is applied without a visible
// reflow. It cannot import anything, so it duplicates the small resolution logic
// from textSize.ts; text-size.test.tsx calls it directly to keep the two in
// agreement. Only non-default sizes are stored on the root, matching
// applyTextSize(). Storage key must match textSize.ts.
export function runTextSizeBoot(): void {
  try {
    const s = localStorage.getItem("remitmortgage-text-size");
    if (s === "large" || s === "x-large") document.documentElement.setAttribute("data-text-size", s);
  } catch {
    /* storage may be unavailable; ignore */
  }
}

// Inline script source: the same self-contained function, invoked immediately.
export const TEXT_SIZE_BOOT_SCRIPT = `(${runTextSizeBoot.toString()})();`;
