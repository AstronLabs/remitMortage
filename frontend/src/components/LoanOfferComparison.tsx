"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { formatRateBps, formatStroops } from "@/lib/amortization";
import {
  compareScenarios,
  formatDelta,
  MAX_SCENARIOS,
  SAVINGS_DURATIONS,
  type LoanScenario,
  type SavingsDuration,
  type ScenarioComparison,
} from "@/lib/loanComparison";
import {
  applyScenarioToOnboarding,
  getLoanComparisonStore,
  useLoanComparison,
} from "@/hooks/useLoanComparison";
import FieldTooltip from "./ui/FieldTooltip";

export interface LoanOfferComparisonProps {
  /** Token ticker shown alongside figures. */
  symbol?: string;
  /** Where "Use this offer" navigates after pre-filling. Set null to stay put. */
  continueHref?: string | null;
}

/** Rows of the comparison table, in display order. */
type MetricRow = {
  key: string;
  label: string;
  hint?: string;
  tooltip?: string;
  render: (entry: ScenarioComparison, symbol: string) => React.ReactNode;
};

/**
 * Side-by-side comparison of up to three loan configurations.
 *
 * Every figure recomputes synchronously from the scenario inputs, so editing a
 * rate or term updates all columns and their deltas as you type. Deltas are
 * measured against the baseline column — by default the first offer — which
 * makes each other column read as "what changes if I switch to this".
 */
export default function LoanOfferComparison({
  symbol = "USDC",
  continueHref = "/onboarding",
}: LoanOfferComparisonProps) {
  const router = useRouter();

  const scenarios = useLoanComparison((s) => s.scenarios);
  const baselineId = useLoanComparison((s) => s.baselineId);
  const selectedId = useLoanComparison((s) => s.selectedId);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);

  // Actions are read straight off the store: they are stable identities, so
  // pulling them through the hydration-guarded selector would be wasted work.
  const store = getLoanComparisonStore().getState();

  const comparisons = useMemo(
    () => compareScenarios(scenarios, baselineId ?? undefined),
    [scenarios, baselineId]
  );

  const money = (value: bigint) => `${formatStroops(value)} ${symbol}`;

  const rows: MetricRow[] = useMemo(
    () => [
      {
        key: "downPayment",
        label: "Down payment",
        hint: "Saved before borrowing",
        tooltip: "The 30% down payment you accumulate in your escrow savings account before the lending pool approves your mortgage.",
        render: (entry) => money(entry.downPayment),
      },
      {
        key: "monthlySavings",
        label: "Monthly savings",
        hint: "To reach the down payment",
        tooltip: "How much you need to deposit each month into your escrow to reach your savings target within the chosen duration.",
        render: (entry) => money(entry.monthlySavings),
      },
      {
        key: "principal",
        label: "Amount financed",
        tooltip: "The 70% loan portion provided by the lending pool after your down payment target is met.",
        render: (entry) => money(entry.principal),
      },
      {
        key: "ltv",
        label: "Loan-to-value",
        tooltip: "The ratio of the loan amount to the property value. Lower LTV means better terms and lower risk.",
        render: (entry) => `${(entry.ltvBps / 100).toFixed(1)}%`,
      },
      {
        key: "monthly",
        label: "Monthly payment",
        render: (entry) => (
          <span className="flex flex-col">
            <span className="font-semibold">{money(entry.monthlyPayment)}</span>
            <DeltaTag delta={entry.monthlyDelta} money={money} isBaseline={entry.isBaseline} />
          </span>
        ),
      },
      {
        key: "interest",
        label: "Total interest",
        render: (entry) => (
          <span className="flex flex-col">
            <span className="font-semibold">{money(entry.totalInterest)}</span>
            <DeltaTag
              delta={entry.totalInterestDelta}
              money={money}
              isBaseline={entry.isBaseline}
            />
          </span>
        ),
      },
      {
        key: "totalCost",
        label: "Total cost",
        hint: "Down payment + all repayments",
        render: (entry) => (
          <span className="flex flex-col">
            <span className="font-semibold">{money(entry.totalCost)}</span>
            <DeltaTag
              delta={entry.totalCostDelta}
              money={money}
              isBaseline={entry.isBaseline}
            />
          </span>
        ),
      },
    ],
    [symbol]
  );

  const handleUse = (scenario: LoanScenario) => {
    const prefill = applyScenarioToOnboarding(scenario);
    store.selectScenario(scenario.id);
    setAppliedNote(
      `${scenario.label} applied — saving ${prefill.savingsTarget.toLocaleString()} ${symbol} over ${prefill.savingsDuration} months.`
    );
    if (continueHref) router.push(continueHref);
  };

  return (
    <section className="p-6 bg-[var(--bg-card)] rounded-md">
      <header className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-semibold">Compare loan offers</h2>
          <p className="text-sm text-[var(--text-muted)]">
            Adjust rate, term and down payment to see what each option really
            costs. Figures match the lending pool&apos;s own schedule.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => store.addScenario()}
            disabled={scenarios.length >= MAX_SCENARIOS}
            className="rounded-lg border border-[var(--text-muted)]/30 px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add offer
          </button>
          <button
            type="button"
            onClick={() => {
              store.reset();
              setAppliedNote(null);
            }}
            className="text-sm underline text-[var(--text-muted)] hover:opacity-80"
          >
            Reset
          </button>
        </div>
      </header>

      {scenarios.length >= MAX_SCENARIOS && (
        <p className="mb-4 text-xs text-[var(--text-muted)]">
          Comparing the maximum of {MAX_SCENARIOS} offers. Remove one to add
          another.
        </p>
      )}

      {appliedNote && (
        <p
          role="status"
          className="mb-4 rounded bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600"
        >
          {appliedNote}
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-sm">
          <caption className="sr-only">
            Loan offer scenarios compared side by side
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-44 px-3 py-2 text-left font-medium text-[var(--text-muted)]">
                Parameter
              </th>
              {comparisons.map((entry) => (
                <th
                  key={entry.scenario.id}
                  scope="col"
                  className={`px-3 py-2 text-left align-top ${
                    entry.isBaseline ? "bg-[var(--text-muted)]/5" : ""
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <input
                      aria-label={`Name for ${entry.scenario.label}`}
                      value={entry.scenario.label}
                      onChange={(e) =>
                        store.updateScenario(entry.scenario.id, {
                          label: e.target.value,
                        })
                      }
                      className="w-full bg-transparent font-semibold outline-none"
                    />
                    {scenarios.length > 1 && (
                      <button
                        type="button"
                        onClick={() => store.removeScenario(entry.scenario.id)}
                        aria-label={`Remove ${entry.scenario.label}`}
                        className="shrink-0 text-[var(--text-muted)] hover:opacity-70"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {entry.isBaseline ? (
                      <Badge tone="neutral">Baseline</Badge>
                    ) : (
                      <button
                        type="button"
                        onClick={() => store.setBaseline(entry.scenario.id)}
                        className="text-[10px] underline text-[var(--text-muted)]"
                      >
                        Set baseline
                      </button>
                    )}
                    {entry.isLowestMonthly && <Badge tone="good">Lowest monthly</Badge>}
                    {entry.isLowestInterest && <Badge tone="good">Least interest</Badge>}
                  </div>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            <ScenarioInputRow
              label="Property value"
              scenarios={comparisons}
              render={(entry) => (
                <NumberInput
                  ariaLabel={`Property value for ${entry.scenario.label}`}
                  value={entry.scenario.propertyValue}
                  min={0}
                  step={1000}
                  onChange={(v) =>
                    store.updateScenario(entry.scenario.id, { propertyValue: v })
                  }
                />
              )}
            />
            <ScenarioInputRow
              label="Down payment"
              hint="Percent of value"
              scenarios={comparisons}
              render={(entry) => (
                <NumberInput
                  ariaLabel={`Down payment percent for ${entry.scenario.label}`}
                  value={entry.scenario.downPaymentPct}
                  min={0}
                  max={100}
                  step={1}
                  suffix="%"
                  onChange={(v) =>
                    store.updateScenario(entry.scenario.id, { downPaymentPct: v })
                  }
                />
              )}
            />
            <ScenarioInputRow
              label="Interest rate"
              scenarios={comparisons}
              render={(entry) => (
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    aria-label={`Interest rate for ${entry.scenario.label}`}
                    min={100}
                    max={2000}
                    step={25}
                    value={entry.scenario.interestRateBps}
                    onChange={(e) =>
                      store.updateScenario(entry.scenario.id, {
                        interestRateBps: Number(e.target.value),
                      })
                    }
                    className="w-full"
                  />
                  <span className="w-16 shrink-0 text-right tabular-nums">
                    {formatRateBps(entry.scenario.interestRateBps)}
                  </span>
                </div>
              )}
            />
            <ScenarioInputRow
              label="Term"
              scenarios={comparisons}
              render={(entry) => (
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    aria-label={`Term in months for ${entry.scenario.label}`}
                    min={6}
                    max={36}
                    step={1}
                    value={entry.scenario.termMonths}
                    onChange={(e) =>
                      store.updateScenario(entry.scenario.id, {
                        termMonths: Number(e.target.value),
                      })
                    }
                    className="w-full"
                  />
                  <span className="w-16 shrink-0 text-right tabular-nums">
                    {entry.scenario.termMonths} mo
                  </span>
                </div>
              )}
            />
            <ScenarioInputRow
              label="Savings plan"
              hint="Time to save the deposit"
              scenarios={comparisons}
              render={(entry) => (
                <select
                  aria-label={`Savings plan for ${entry.scenario.label}`}
                  value={entry.scenario.savingsMonths}
                  onChange={(e) =>
                    store.updateScenario(entry.scenario.id, {
                      savingsMonths: Number(e.target.value) as SavingsDuration,
                    })
                  }
                  className="rounded border border-[var(--text-muted)]/30 bg-transparent px-2 py-1"
                >
                  {SAVINGS_DURATIONS.map((months) => (
                    <option key={months} value={months}>
                      {months} months
                    </option>
                  ))}
                </select>
              )}
            />

            <tr>
              <td
                colSpan={comparisons.length + 1}
                className="px-3 pt-5 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
              >
                Results
              </td>
            </tr>

            {rows.map((row) => (
              <tr key={row.key} className="border-t border-[var(--text-muted)]/10">
                <th scope="row" className="px-3 py-3 text-left font-normal align-top">
                  <span className="flex items-center gap-1">
                    {row.label}
                    {row.tooltip && <FieldTooltip content={row.tooltip} />}
                  </span>
                  {row.hint && (
                    <span className="block text-xs text-[var(--text-muted)]">
                      {row.hint}
                    </span>
                  )}
                </th>
                {comparisons.map((entry) => (
                  <td
                    key={entry.scenario.id}
                    className={`px-3 py-3 align-top tabular-nums ${
                      entry.isBaseline ? "bg-[var(--text-muted)]/5" : ""
                    }`}
                  >
                    {row.render(entry, symbol)}
                  </td>
                ))}
              </tr>
            ))}

            <tr className="border-t border-[var(--text-muted)]/10">
              <td className="px-3 py-4" />
              {comparisons.map((entry) => (
                <td
                  key={entry.scenario.id}
                  className={`px-3 py-4 ${entry.isBaseline ? "bg-[var(--text-muted)]/5" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => handleUse(entry.scenario)}
                    aria-pressed={selectedId === entry.scenario.id}
                    className={`w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                      selectedId === entry.scenario.id
                        ? "bg-emerald-500 text-white"
                        : "border border-[var(--text-muted)]/30 hover:border-[var(--text-muted)]/60"
                    }`}
                  >
                    {selectedId === entry.scenario.id ? "Selected" : "Use this offer"}
                  </button>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Presentational helpers ──────────────────────────────────────────────────

function Badge({
  tone,
  children,
}: {
  tone: "good" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
        tone === "good"
          ? "bg-emerald-500/15 text-emerald-600"
          : "bg-[var(--text-muted)]/15 text-[var(--text-muted)]"
      }`}
    >
      {children}
    </span>
  );
}

/** Signed difference against the baseline; blank on the baseline itself. */
function DeltaTag({
  delta,
  money,
  isBaseline,
}: {
  delta: bigint;
  money: (value: bigint) => string;
  isBaseline: boolean;
}) {
  if (isBaseline) {
    return <span className="text-xs text-[var(--text-muted)]">baseline</span>;
  }
  const text = formatDelta(delta, money);
  const tone =
    delta === 0n
      ? "text-[var(--text-muted)]"
      : delta < 0n
        ? "text-emerald-600"
        : "text-amber-600";
  return <span className={`text-xs ${tone}`}>{text}</span>;
}

function NumberInput({
  value,
  onChange,
  ariaLabel,
  min,
  max,
  step,
  suffix,
}: {
  value: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <span className="flex items-center gap-1">
      <input
        type="number"
        aria-label={ariaLabel}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded border border-[var(--text-muted)]/30 bg-transparent px-2 py-1 tabular-nums"
      />
      {suffix && <span className="text-[var(--text-muted)]">{suffix}</span>}
    </span>
  );
}

function ScenarioInputRow({
  label,
  hint,
  scenarios,
  render,
}: {
  label: string;
  hint?: string;
  scenarios: ScenarioComparison[];
  render: (entry: ScenarioComparison) => React.ReactNode;
}) {
  return (
    <tr className="border-t border-[var(--text-muted)]/10">
      <th scope="row" className="px-3 py-3 text-left font-normal align-middle">
        {label}
        {hint && (
          <span className="block text-xs text-[var(--text-muted)]">{hint}</span>
        )}
      </th>
      {scenarios.map((entry) => (
        <td
          key={entry.scenario.id}
          className={`px-3 py-3 align-middle ${
            entry.isBaseline ? "bg-[var(--text-muted)]/5" : ""
          }`}
        >
          {render(entry)}
        </td>
      ))}
    </tr>
  );
}
