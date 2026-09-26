// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * WCAG 2.x colour-contrast audit for the design-system tokens (issue #698).
 *
 * `auditContrast(css)` reads the token blocks from `globals.css`, resolves
 * every theme the app can render (dark/light × default/colour-blind palette),
 * and checks each text/background pairing in {@link CONTRAST_PAIRS} against
 * WCAG AA. `__tests__/contrastAudit.test.ts` runs it in CI, so a token change
 * that drops a pairing below AA fails the build.
 */

/** WCAG AA minimum ratios. */
export const WCAG_AA_BODY = 4.5;
export const WCAG_AA_LARGE = 3;

export type TextSize = "body" | "large";

export interface ContrastPair {
  /** Foreground (text) token, without the leading `--`. */
  fg: string;
  /** Background token the text sits on. */
  bg: string;
  /** `body` needs 4.5:1; `large` (>= 24px, or >= 18.66px bold) needs 3:1. */
  size: TextSize;
}

/** Surfaces text is rendered on. */
const SURFACES = ["bg-primary", "bg-secondary", "bg-card"] as const;

/** Tokens used as text colours on those surfaces. */
const TEXT_TOKENS = [
  "text-primary",
  "text-secondary",
  "text-muted",
  "accent-primary",
  "accent-secondary",
  "success",
  "warning",
  "error",
  "status-success",
  "status-warning",
  "status-error",
  "status-info",
  "status-pending",
  "status-overdue",
  "status-healthy",
  "status-neutral",
] as const;

/** Every text/background token pairing used for body text. */
export const CONTRAST_PAIRS: ContrastPair[] = TEXT_TOKENS.flatMap((fg) =>
  SURFACES.map((bg) => ({ fg, bg, size: "body" as const }))
);

/**
 * Colour tokens that are intentionally not audited because they never carry
 * text. Keep the reason next to each entry; anything used for text belongs in
 * {@link CONTRAST_PAIRS} instead.
 */
export const DECORATIVE_EXEMPTIONS: Record<string, string> = {
  "color-border": "hairline borders and dividers, not text",
  "border-color": "hairline borders and dividers, not text",
  "color-border-glow": "focus/hover glow, not text",
  "border-glow": "focus/hover glow, not text",
  "color-indigo": "gradient stop and decorative glow only",
  "color-accent-pink": "gradient stop and decorative glow only",
  "color-accent-purple": "gradient stop and decorative glow only",
  "accent-primary-light": "hover fill for buttons; label contrast comes from the button text",
  "bg-glass": "translucent overlay tinting the surface beneath it, not a text surface",
};

/** Themes the app can render, matching the attributes set on `<html>`. */
export const THEMES = [
  { name: "dark", theme: "dark", palette: "default" },
  { name: "light", theme: "light", palette: "default" },
  { name: "dark + colorblind", theme: "dark", palette: "colorblind" },
  { name: "light + colorblind", theme: "light", palette: "colorblind" },
] as const;

type Tokens = Record<string, string>;

/** Custom-property declarations from the first rule whose selector is `selector`. */
export function extractBlock(css: string, selector: string): Tokens {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  const tokens: Tokens = {};
  if (!match) return tokens;
  const body = match[2].replace(/\/\*[\s\S]*?\*\//g, "");
  for (const decl of body.split(";")) {
    const m = /^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
    if (m) tokens[m[1]] = m[2];
  }
  return tokens;
}

/**
 * Tokens in effect for a theme. Blocks are merged in the order they appear in
 * `globals.css`, which is the cascade order the browser applies when both
 * attributes sit on `<html>`.
 */
export function themeTokens(
  css: string,
  theme: "dark" | "light",
  palette: "default" | "colorblind"
): Tokens {
  const tokens: Tokens = { ...extractBlock(css, ":root") };
  if (theme === "light") Object.assign(tokens, extractBlock(css, '[data-theme="light"]'));
  if (palette === "colorblind")
    Object.assign(tokens, extractBlock(css, '[data-palette="colorblind"]'));
  if (theme === "light" && palette === "colorblind") {
    Object.assign(tokens, extractBlock(css, '[data-theme="light"][data-palette="colorblind"]'));
  }
  return tokens;
}

/** Follow `var(--x)` references until a literal colour is reached. */
export function resolveToken(tokens: Tokens, name: string, seen: Set<string> = new Set()): string {
  if (seen.has(name)) throw new Error(`Circular token reference: --${name}`);
  const value = tokens[name];
  if (value === undefined) throw new Error(`Undefined token: --${name}`);
  const ref = /^var\(\s*--([\w-]+)\s*\)$/.exec(value);
  if (!ref) return value;
  seen.add(name);
  return resolveToken(tokens, ref[1], seen);
}

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(value: string): Rgba {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (rgb) {
    return { r: +rgb[1], g: +rgb[2], b: +rgb[3], a: rgb[4] === undefined ? 1 : +rgb[4] };
  }
  throw new Error(`Unsupported colour value: ${value}`);
}

/** Alpha-composite `top` over an opaque `bottom`. */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

export function relativeLuminance({ r, g, b }: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastResult extends ContrastPair {
  theme: string;
  ratio: number;
  required: number;
  pass: boolean;
}

/** Audit every pairing in every theme. */
export function auditContrast(
  css: string,
  pairs: ContrastPair[] = CONTRAST_PAIRS
): ContrastResult[] {
  const results: ContrastResult[] = [];
  for (const t of THEMES) {
    const tokens = themeTokens(css, t.theme, t.palette);
    const page = parseColor(resolveToken(tokens, "bg-primary"));
    for (const pair of pairs) {
      // Translucent surfaces sit on the page background; translucent text on the surface.
      const bg = composite(parseColor(resolveToken(tokens, pair.bg)), page);
      const fg = composite(parseColor(resolveToken(tokens, pair.fg)), bg);
      const ratio = contrastRatio(fg, bg);
      const required = pair.size === "large" ? WCAG_AA_LARGE : WCAG_AA_BODY;
      results.push({ ...pair, theme: t.name, ratio, required, pass: ratio >= required });
    }
  }
  return results;
}
