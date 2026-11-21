// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { create } from "zustand";
import {
  applyTextSize,
  persistTextSize,
  resolveTextSize,
  type TextSize,
} from "../lib/textSize";

interface TextSizeState {
  textSize: TextSize;
  /**
   * Set the text scale. Applies immediately to the document root and persists
   * to this device; the settings screen additionally syncs it to the user's
   * account so the choice follows them across sessions and browsers.
   */
  setTextSize: (size: TextSize) => void;
}

/** Initial state as read from this device, exported so tests can re-initialise. */
export function readInitialTextSizeState(): Pick<TextSizeState, "textSize"> {
  return { textSize: resolveTextSize() };
}

export const useTextSizeStore = create<TextSizeState>((set) => ({
  ...readInitialTextSizeState(),

  setTextSize: (size) => {
    persistTextSize(size);
    applyTextSize(size);
    set({ textSize: size });
  },
}));
