"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useDirection } from "@/context/DirectionContext";
import { mirroredAxes, type ChartMargin, type Direction, type MirroredAxes } from "@/lib/direction";

export interface ChartDirection extends MirroredAxes {
  direction: Direction;
  /** Convenience flag: `direction === "rtl"`. */
  isRtl: boolean;
  /**
   * Mirror a chart's horizontal margins for the active direction (the value
   * axis swaps edges, so asymmetric offsets must follow).
   */
  margin: (margin: ChartMargin) => ChartMargin;
}

/**
 * Mirroring props for a horizontal recharts chart. Spread them onto the axes:
 *
 * ```tsx
 * const chart = useChartDirection();
 * <XAxis reversed={chart.reversed} />
 * <YAxis orientation={chart.yAxisOrientation} />
 * ```
 *
 * Only the axis order moves — tick labels and numbers keep their normal
 * left-to-right reading order because their glyphs are never transformed.
 */
export function useChartDirection(): ChartDirection {
  const { direction, isRtl } = useDirection();
  const axes = mirroredAxes(direction);
  return {
    direction,
    isRtl,
    ...axes,
    margin:
      direction === "rtl"
        ? (m) => ({ ...m, left: m.right, right: m.left })
        : (m) => m,
  };
}
