"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { createContext, useContext } from "react";
import { DEFAULT_DIRECTION, type Direction } from "@/lib/direction";

type DirectionContextValue = {
  /** Active text/layout direction. */
  direction: Direction;
  /** Convenience flag: `direction === "rtl"`. */
  isRtl: boolean;
};

const DirectionContext = createContext<DirectionContextValue | undefined>(undefined);

export function DirectionProvider({
  direction,
  children,
}: {
  direction: Direction;
  children: React.ReactNode;
}) {
  return (
    <DirectionContext.Provider value={{ direction, isRtl: direction === "rtl" }}>
      {children}
    </DirectionContext.Provider>
  );
}

function realtimeDirection(): Direction {
  if (typeof document !== "undefined" && document.documentElement.dir === "rtl") {
    return "rtl";
  }
  return DEFAULT_DIRECTION;
}

/**
 * Resolve the active layout direction.
 *
 * Prefers the {@link DirectionProvider} (seeded from the request locale) and
 * falls back to the `dir` attribute the server sets on `<html>`, so charts and
 * progress indicators still mirror correctly when mounted outside the provider.
 */
export function useDirection(): DirectionContextValue {
  const ctx = useContext(DirectionContext);
  if (ctx) return ctx;
  const direction = realtimeDirection();
  return { direction, isRtl: direction === "rtl" };
}

export default DirectionContext;
