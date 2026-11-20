"use client";

import { useId, useState } from "react";
import { formatStroops, toStroops } from "@/lib/amortization";
import { computePayoffCountdown } from "@/lib/payoffCountdown";

interface PaymentSimulatorProps {
  balance: number;
  monthlyAmount: number;
  paymentsRemaining: number;
  totalInterest: number;
}

export default function PaymentSimulator({ balance, monthlyAmount, paymentsRemaining, totalInterest }: PaymentSimulatorProps) {
  const headingId = useId();
  const [monthly, setMonthly] = useState("");
  const [lump, setLump] = useState("");
  const monthlyExtra = Number(monthly);
  const lumpSum = Number(lump);
  const valid = Number.isFinite(monthlyExtra) && monthlyExtra >= 0 && Number.isFinite(lumpSum) && lumpSum >= 0;
  const owed = Math.max(0, balance - lumpSum);
  const projectedPayments = valid && (monthlyExtra || lumpSum)
    ? Math.min(paymentsRemaining, Math.ceil(owed / (monthlyAmount + monthlyExtra)))
    : paymentsRemaining;
  const { estimatedPayoffDate } = computePayoffCountdown(0, projectedPayments);
  const payoff = estimatedPayoffDate?.toLocaleDateString(undefined, { dateStyle: "medium" }) ?? "Today";

  return (
    <section aria-labelledby={headingId} className="mt-6 rounded-lg border border-[var(--border-color)] p-4">
      <h3 id={headingId} className="font-semibold">What-if payment simulator</h3>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Estimate how extra payments would change your payoff date. These inputs are kept on this page.
      </p>
      <div className="my-4 grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">
          Extra monthly payment (USDC)
          <input className="rounded border border-[var(--border-color)] bg-transparent p-2" type="number" min="0" step="0.01" value={monthly} onChange={event => setMonthly(event.target.value)} />
        </label>
        <label className="grid gap-1 text-sm">
          One-time payment today (USDC)
          <input className="rounded border border-[var(--border-color)] bg-transparent p-2" type="number" min="0" step="0.01" value={lump} onChange={event => setLump(event.target.value)} />
        </label>
      </div>
      <div role="status" className="text-sm">
        {valid ? (
          <>
            <dl className="grid gap-2 sm:grid-cols-2">
              <div><dt>Estimated payoff</dt><dd className="font-semibold">{payoff}</dd></div>
              <div><dt>Months removed</dt><dd className="font-semibold">{paymentsRemaining - projectedPayments}</dd></div>
              <div><dt>Total interest</dt><dd className="font-semibold">{formatStroops(toStroops(totalInterest))} USDC</dd></div>
              <div><dt>Interest saved</dt><dd className="font-semibold">0.00 USDC</dd></div>
            </dl>
            <p className="mt-2 text-[var(--text-muted)]">This loan charges flat interest for the term. Paying early shortens the schedule and leaves the interest amount fixed.</p>
          </>
        ) : "Enter a non-negative amount for each extra payment."}
      </div>
    </section>
  );
}
