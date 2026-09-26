/**
 * WCAG AA colour-contrast audit for the design-system tokens (issue #698).
 * Fails CI when a text/background token pairing in any theme drops below
 * 4.5:1 (body text) or 3:1 (large text). Run alone with `npm run contrast:check`.
 */
import { readFileSync } from "fs";
import path from "path";
import {
  CONTRAST_PAIRS,
  DECORATIVE_EXEMPTIONS,
  WCAG_AA_BODY,
  auditContrast,
  contrastRatio,
  parseColor,
  resolveToken,
  themeTokens,
} from "../src/lib/contrast";

const css = readFileSync(path.join(__dirname, "../src/app/globals.css"), "utf8");

describe("contrast math", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio(parseColor("#000"), parseColor("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor("#777777"), parseColor("#ffffff"))).toBeCloseTo(4.48, 2);
    expect(contrastRatio(parseColor("#ffffff"), parseColor("#ffffff"))).toBeCloseTo(1, 5);
  });

  it("parses hex and rgba colours", () => {
    expect(parseColor("#0f0")).toEqual({ r: 0, g: 255, b: 0, a: 1 });
    expect(parseColor("rgba(15, 23, 42, 0.7)")).toEqual({ r: 15, g: 23, b: 42, a: 0.7 });
  });

  it("resolves var() chains per theme", () => {
    const dark = themeTokens(css, "dark", "default");
    const light = themeTokens(css, "light", "default");
    expect(resolveToken(dark, "text-muted")).toBe(resolveToken(dark, "color-text-3"));
    expect(resolveToken(light, "text-primary")).toBe("#0f172a");
  });

  it("flags a pairing that falls below AA", () => {
    const failing = `:root { --bg-primary: #ffffff; --grey: #999999; }`;
    const [result] = auditContrast(failing, [{ fg: "grey", bg: "bg-primary", size: "body" }]);
    expect(result.pass).toBe(false);
    expect(result.ratio).toBeLessThan(WCAG_AA_BODY);
  });
});

describe("design system tokens meet WCAG AA", () => {
  const results = auditContrast(css);

  it("audits every pairing in all four themes", () => {
    expect(results).toHaveLength(CONTRAST_PAIRS.length * 4);
  });

  it("has no failing text/background pairing", () => {
    const failures = results
      .filter((r) => !r.pass)
      .map(
        (r) =>
          `${r.theme}: --${r.fg} on --${r.bg} = ${r.ratio.toFixed(2)}:1 (needs ${r.required}:1)`
      );
    expect(failures).toEqual([]);
  });

  it("never exempts a token that is audited as text", () => {
    const audited = new Set(CONTRAST_PAIRS.flatMap((p) => [p.fg, p.bg]));
    expect(Object.keys(DECORATIVE_EXEMPTIONS).filter((t) => audited.has(t))).toEqual([]);
  });
});
