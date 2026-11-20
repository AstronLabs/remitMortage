// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Text/layout direction helpers.
 *
 * Charts and progress indicators must mirror in right-to-left locales so time
 * and progress read in the locale's natural direction. Only the layout is
 * mirrored — numeric labels and axis text keep their usual left-to-right
 * reading order, because glyphs are never transformed.
 */

export type Direction = "ltr" | "rtl";

export const DEFAULT_DIRECTION: Direction = "ltr";

/** Primary language subtags whose scripts read right-to-left. */
const RTL_LANGUAGE_SUBTAGS = new Set([
  "ar", // Arabic
  "he", // Hebrew
  "fa", // Persian
  "ur", // Urdu
  "yi", // Yiddish
  "dv", // Dhivehi
  "ps", // Pashto
  "sd", // Sindhi
  "ug", // Uyghur
]);

/** The primary language subtag of a BCP-47 tag, lower-cased ("ar-EG" -> "ar"). */
export function primaryLanguageSubtag(locale: string): string {
  return locale.trim().toLowerCase().split(/[-_]/)[0] ?? "";
}

export function isRtlLocale(locale: string): boolean {
  return RTL_LANGUAGE_SUBTAGS.has(primaryLanguageSubtag(locale));
}

export function directionForLocale(locale: string): Direction {
  return isRtlLocale(locale) ? "rtl" : "ltr";
}

export interface MirroredAxes {
  /** Time/category axis: reverse so the series reads right-to-left. */
  reversed: boolean;
  /** Value axis side: the right edge in RTL. */
  yAxisOrientation: "left" | "right";
  /** Legend alignment. */
  legendAlign: "left" | "right";
}

/**
 * Axis orientation for a horizontal (time/category) chart in the given
 * direction. Reversing the x-axis and moving the value axis to the right
 * mirrors the plot; tick *labels* stay readable because only their order
 * changes, not the glyphs.
 */
export function mirroredAxes(direction: Direction): MirroredAxes {
  const rtl = direction === "rtl";
  return {
    reversed: rtl,
    yAxisOrientation: rtl ? "right" : "left",
    legendAlign: rtl ? "right" : "left",
  };
}

/**
 * Mirror a horizontal interval measured from the inline-start edge: given an
 * interval `[x, x + width]` inside a total width `total`, return its mirrored
 * start so the same content lays out from the opposite edge.
 */
export function mirrorInterval(x: number, width: number, total: number): number {
  return total - x - width;
}

export interface ChartMargin {
  top?: number;
  right?: number;
  left?: number;
  bottom?: number;
}

/**
 * Mirror a chart's horizontal margins for the reading direction. The value
 * axis swaps edges, so any asymmetric offset (e.g. a negative `left` that
 * compensates for a left-hand axis) must move to the opposite side too.
 */
export function mirrorChartMargin(margin: ChartMargin, direction: Direction): ChartMargin {
  if (direction !== "rtl") return margin;
  return { ...margin, left: margin.right, right: margin.left };
}

