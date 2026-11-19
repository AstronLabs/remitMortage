import { summarizeShares, summarizeTrend } from "../src/lib/chart-summary";

describe("summarizeTrend", () => {
  const fmt = (v: number) => `$${v}`;

  it("reports a rise with percentage and endpoints", () => {
    const text = summarizeTrend(
      "TVL",
      [
        { label: "Jan", value: 100 },
        { label: "Feb", value: 150 },
      ],
      fmt
    );
    expect(text).toBe("TVL rose 50.0% from $100 in Jan to $150 in Feb.");
  });

  it("reports a fall and mentions an earlier peak", () => {
    const text = summarizeTrend(
      "APY",
      [
        { label: "Jan", value: 10 },
        { label: "Feb", value: 20 },
        { label: "Mar", value: 5 },
      ],
      fmt
    );
    expect(text).toContain("fell 50.0%");
    expect(text).toContain("peaking at $20 in Feb");
  });

  it("calls near-identical endpoints flat", () => {
    expect(
      summarizeTrend("Rate", [
        { label: "Jan", value: 5 },
        { label: "Feb", value: 5 },
      ])
    ).toBe("Rate was flat at about 5.");
  });

  it("handles empty and single-point series", () => {
    expect(summarizeTrend("TVL", [])).toBe("TVL: no data available.");
    expect(summarizeTrend("TVL", [{ label: "Jan", value: 3 }], fmt)).toBe("TVL: $3 in Jan.");
  });

  it("ignores non-finite values", () => {
    expect(summarizeTrend("TVL", [{ label: "Jan", value: NaN }])).toBe("TVL: no data available.");
  });
});

describe("summarizeShares", () => {
  it("names the largest share and lists the rest", () => {
    expect(
      summarizeShares("Loan performance", [
        { label: "Repaid", value: 20 },
        { label: "Active", value: 70 },
        { label: "Defaulted", value: 10 },
      ])
    ).toBe("Loan performance: Active is the largest share at 70%; Repaid 20%, Defaulted 10%.");
  });

  it("handles empty input", () => {
    expect(summarizeShares("Loan performance", [])).toBe("Loan performance: no data available.");
  });
});
