# Accessible Data Table Alternative for Charts

Charts convey their data visually only. Every chart therefore offers an
equivalent data table and a short text summary
(`components/charts/AccessibleChart.tsx`, `lib/chart-summary.ts`).

## Behaviour

- **Summary** above the chart: one or two sentences with the main trend, e.g.
  "Deposits rose 50.0% from $1,000 in Jan to $1,500 in Dec, peaking at …".
  Built by `summarizeTrend` (time series) or `summarizeShares` (pie/donut) from
  the same data the chart plots, and linked to the chart with `aria-describedby`.
- **Toggle** button ("View as table" / "View as chart", `aria-pressed`). The
  chart stays mounted (hidden) while the table shows, so PNG export, filters and
  time ranges keep working; switching back needs no refetch.
- **Table** is a real `<table>`: a `<caption>` that names the chart and the
  active filter/time range, `<th scope="col">` column headers and
  `<th scope="row">` row headers. It sits in a focusable, labelled scroll region
  (`role="region"`, `tabindex="0"`) so keyboard users can scroll long tables.
  Focus stays on the toggle when switching, and a polite live region announces
  the change ("Showing Volume Trends as a data table with 12 rows.").
- **Same data.** The table renders the exact `ChartExportData` rows that also
  drive the chart's CSV export, so it reflects the active filters and time
  range and cannot drift from what is plotted.

## Adding it to a chart

```tsx
const table = useMemo<ChartExportData>(() => ({
  columns: ["Month", "Deposits (USDC)"],
  rows: data.map((d) => [d.month, d.deposits]),
}), [data]);

<AccessibleChart
  chartTitle="Volume Trends (USDC)"
  summary={summarizeTrend("Deposits", data.map((d) => ({ label: d.month, value: d.deposits })))}
  data={table}
  filterDescription={`Time range: ${timeRange}.`}
>
  <ResponsiveContainer>…</ResponsiveContainer>
</AccessibleChart>
```

Applied to: Volume Trends, Loan Performance (analytics), Total Value Locked and
Estimated Pool APY (`YieldAnalyticsChart`), and the Portfolio ROI Projection.

## Tests

`components/charts/__tests__/AccessibleChart.test.tsx` checks that the table
values equal the plotted data row for row, proper header scopes and caption,
keyboard operation (Tab, Enter/Space, focusable scroll region), announcements,
and that the chart stays mounted. `__tests__/chart-summary.test.ts` covers the
summaries.
