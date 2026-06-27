"use client"

export const dynamic = "force-dynamic";

import React, { useEffect, useState, useRef } from "react";
import loadDynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Horizon } from "@stellar/stellar-sdk";
import { WalletProvider, useWallet } from "../../context/WalletContext";
import {
  consumeTxSuccessFeedback,
  shortenAddress,
  STELLARCHAIN_TX_BASE,
} from "../../lib/transaction-status";

const Navbar = loadDynamic(() => import("../../components/Navbar"), { ssr: false });

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const PAGE_SIZE = 10;

// TODO: load from env or backend config
const LENDING_POOL_CONTRACT_ID = "CA3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3J5V2V5C3";

type LoanRecord = {
  status: string;
  principal: string;
  disbursed: string;
  repaid: string;
  interestRateBps: number;
  outstandingDebt: string;
};

type RepaymentSchedule = {
  monthlyAmount: number;
  durationMonths: number;
  paymentsMade: number;
  paymentsMissed: number;
};

type TxRecord = {
  id: string;
  date: string;
  amount: string;
  hash: string;
  from: string;
  to: string;
  memo?: string;
};

function formatUSDC(raw: string | number): string {
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(1) + "%";
}

function shorten(addr: string) {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}\u2026${addr.slice(-4)}`;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ── Circular Progress ──────────────────────────────────────────────────────

function CircularProgress({ pct, size = 120 }: { pct: number; size?: number }) {
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (Math.min(pct, 100) / 100) * circumference;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-color)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--accent-primary)"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-700"
      />
    </svg>
  );
}

// ── Confetti ───────────────────────────────────────────────────────────────

function Confetti() {
  const particles = useRef(() => {
    const colors = ["#6366f1", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#a855f7"];
    return Array.from({ length: 60 }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      delay: `${Math.random() * 2}s`,
      duration: `${2 + Math.random() * 3}s`,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: `${6 + Math.random() * 8}px`,
    }));
  }).current();

  return (
    <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
      {particles.map((p) => (
        <div
          key={p.id}
          className="absolute rounded-sm"
          style={{
            left: p.left,
            top: "-10px",
            width: p.size,
            height: p.size,
            backgroundColor: p.color,
            animation: `confetti-fall ${p.duration} ${p.delay} ease-in infinite`,
          }}
        />
      ))}
      <style>{`
        @keyframes confetti-fall {
          0% { transform: translateY(-10px) rotate(0deg); opacity: 1; }
          100% { transform: translateY(100vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

// ── Inner Component ────────────────────────────────────────────────────────

function RepayInner() {
  const router = useRouter();
  const { publicKey, isConnected, connect } = useWallet();

  // Loan data
  const [loan, setLoan] = useState<LoanRecord | null>(null);
  const [schedule, setSchedule] = useState<RepaymentSchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txSuccess, setTxSuccess] = useState<{ hash: string; type: string } | null>(null);

  // Payment form
  const [payAmount, setPayAmount] = useState("");
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [paySuccess, setPaySuccess] = useState(false);

  // Transaction history
  const [records, setRecords] = useState<TxRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  // ── Check tx feedback on mount ────────────────────────────────────────────

  useEffect(() => {
    const feedback = consumeTxSuccessFeedback();
    if (feedback) {
      setTxSuccess(feedback);
    }
  }, []);

  // ── Load loan data ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isConnected) {
      router.push("/");
      return;
    }
    if (!publicKey) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/borrower/${publicKey}/status`);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        const data = await res.json();

        if (cancelled) return;

        // Map API response to full loan record with placeholders for missing fields
        const loanRecord: LoanRecord = {
          status: data.loan?.status === "none" ? "none" : data.loan?.status || "none",
          principal: data.loan?.principal || "0",
          disbursed: data.loan?.disbursed || "0",
          repaid: data.loan?.repaid || "0",
          interestRateBps: 800, // TODO: fetch from lending pool contract via get_loan_info()
          outstandingDebt: data.loan?.principal || "0",
        };
        setLoan(loanRecord);

        // Compute schedule from loan data + contract defaults
        // TODO: replace with get_repayment_schedule() Soroban query
        const principal = Number(loanRecord.principal) || 0;
        const interest = (principal * loanRecord.interestRateBps) / 10000;
        const totalOwed = principal + interest;
        const months = 12;
        const monthlyAmount = months > 0 ? totalOwed / months : 0;
        const repaid = Number(loanRecord.repaid) || 0;
        const paymentsMade = monthlyAmount > 0 ? Math.floor(repaid / monthlyAmount) : 0;

        setSchedule({
          monthlyAmount,
          durationMonths: months,
          paymentsMade,
          paymentsMissed: 0,
        });

        // Pre-fill payment amount
        setPayAmount(formatUSDC(monthlyAmount));
      } catch (e: any) {
        if (!cancelled) setError(e?.message || "Failed to load loan data");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [isConnected, publicKey, router]);

  // ── Load transaction history from Horizon ─────────────────────────────────

  useEffect(() => {
    if (!publicKey) return;

    const accountId = publicKey;
    let cancelled = false;

    async function loadHistory() {
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const server = new Horizon.Server(HORIZON_TESTNET);
        const result = await server
          .payments()
          .forAccount(accountId)
          .limit(PAGE_SIZE)
          .order("desc")
          .call();

        if (cancelled) return;

        const parsed: TxRecord[] = (result.records as any[])
          .filter((op: any) => {
            if (op.type !== "payment") return false;
            if (op.asset_code !== "USDC") return false;
            // Filter to payments involving the lending pool contract
            // TODO: use real contract ID from env
            const poolId = LENDING_POOL_CONTRACT_ID;
            if (op.to !== poolId && op.from !== poolId) return false;
            return true;
          })
          .map((op: any) => ({
            id: op.id,
            date: op.created_at,
            amount: parseFloat(op.amount).toFixed(2),
            hash: op.transaction_hash,
            from: op.from,
            to: op.to,
          }));

        setRecords(parsed);
      } catch (e: any) {
        if (!cancelled) setHistoryError(e?.message || "Failed to load transaction history");
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    }

    loadHistory();
    return () => {
      cancelled = true;
    };
  }, [publicKey]);

  // ── Derived values ────────────────────────────────────────────────────────

  const principal = Number(loan?.principal) || 0;
  const repaid = Number(loan?.repaid) || 0;
  const interest = (principal * (loan?.interestRateBps || 0)) / 10000;
  const totalOwed = principal + interest;
  const remaining = Math.max(0, totalOwed - repaid);
  const progressPct = totalOwed > 0 ? Math.min(100, Math.round((repaid / totalOwed) * 100)) : 0;
  const isRepaid = loan?.status === "Repaid" || (totalOwed > 0 && repaid >= totalOwed);

  // ── Handle repay ──────────────────────────────────────────────────────────

  async function handleRepay(e: React.FormEvent) {
    e.preventDefault();
    setPayError(null);
    setPaySuccess(false);

    const amount = parseFloat(payAmount.replace(/,/g, ""));
    if (isNaN(amount) || amount <= 0) {
      setPayError("Enter a valid positive USDC amount.");
      return;
    }

    if (amount > remaining) {
      setPayError("Amount exceeds remaining balance.");
      return;
    }

    if (!isConnected || !publicKey) {
      setPayError("Connect your wallet first.");
      return;
    }

    const confirmed = window.confirm(
      `Confirm repayment of ${formatUSDC(amount)} USDC?\n\nThis will sign a transaction via Freighter.`
    );
    if (!confirmed) return;

    setPaying(true);
    try {
      // TODO: Build and submit Soroban transaction via Freighter:
      //   1. Load lending pool contract spec
      //   2. Build contract invocation: lending_pool::repay(borrower, loan_id, amount)
      //   3. Simulate via Soroban RPC
      //   4. Sign with Freighter: signTransaction(txXdr, { networkPassphrase })
      //   5. Submit via Soroban RPC: sendTransaction(signedTx)
      //   6. Redirect to /tx/{hash} for monitoring
      //   7. Store feedback: storeTxSuccessFeedback(hash, "Repayment")

      await new Promise((r) => setTimeout(r, 1200));

      // Optimistically update local state
      setLoan((prev) =>
        prev
          ? {
              ...prev,
              repaid: String((repaid + amount).toFixed(2)),
              status: repaid + amount >= totalOwed ? "Repaid" : prev.status,
            }
          : prev
      );

      setPayAmount("");
      setPaySuccess(true);
      setTimeout(() => setPaySuccess(false), 5000);
    } catch (err: any) {
      setPayError(err?.message || "Repayment transaction failed.");
    } finally {
      setPaying(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <Navbar />

      {isRepaid && <Confetti />}

      <main className="max-w-5xl mx-auto px-6 py-24">
        <h1 className="text-3xl font-bold mb-2">Loan Repayment</h1>
        <p className="text-[var(--text-secondary)] mb-8">
          Manage your loan payments, view your schedule, and track repayment history.
        </p>

        {/* ── Tx Success Banner ── */}
        {txSuccess && (
          <div
            role="status"
            className="mb-6 p-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
          >
            <div>
              <p className="text-sm font-semibold text-emerald-400">
                {txSuccess.type} confirmed successfully
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                Transaction {shortenAddress(txSuccess.hash)} is on-chain.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                href={`${STELLARCHAIN_TX_BASE}${txSuccess.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-[var(--accent-primary-light)] hover:underline"
              >
                View on explorer
              </a>
              <button
                type="button"
                onClick={() => setTxSuccess(null)}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* ── Loading / Error ── */}
        {loading && (
          <div className="p-6 bg-[var(--bg-card)] rounded-md text-sm text-[var(--text-muted)]">
            Loading loan data{"\u2026"}
          </div>
        )}

        {error && !loading && (
          <div role="alert" className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            {error}
          </div>
        )}

        {/* ── Completion Banner ── */}
        {isRepaid && !loading && !error && (
          <div className="mb-8 p-8 rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-emerald-500/5 text-center animate-fade-in-up">
            <div className="text-5xl mb-4">{'\u{1F389}'}</div>
            <h2 className="text-2xl font-bold gradient-text mb-2">Loan Fully Repaid</h2>
            <p className="text-[var(--text-secondary)] max-w-md mx-auto">
              Congratulations! You have successfully repaid your entire loan. Your financial freedom
              journey continues.
            </p>
          </div>
        )}

        {/* ── Main Content ── */}
        {!loading && !error && loan && loan.status !== "none" && (
          <>
            {/* ── Loan Summary Card ── */}
            <section aria-labelledby="summary-heading" className="mb-8 animate-fade-in-up">
              <h2 id="summary-heading" className="sr-only">Loan Summary</h2>
              <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
                <div className="flex flex-col md:flex-row items-start md:items-center gap-6">
                  {/* Circular progress */}
                  <div className="flex-shrink-0 flex flex-col items-center">
                    <div className="relative">
                      <CircularProgress pct={progressPct} size={130} />
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="text-xl font-bold">{progressPct}%</span>
                      </div>
                    </div>
                    <span className="text-xs text-[var(--text-muted)] mt-1">repaid</span>
                  </div>

                  {/* Details */}
                  <div className="flex-1 grid grid-cols-2 sm:grid-cols-3 gap-4 w-full">
                    <div>
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">Principal</p>
                      <p className="text-sm font-semibold">{formatUSDC(principal)} USDC</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">Interest Rate</p>
                      <p className="text-sm font-semibold text-indigo-400">
                        {bpsToPercent(loan.interestRateBps)}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">Total Owed</p>
                      <p className="text-sm font-semibold">{formatUSDC(totalOwed)} USDC</p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">Amount Repaid</p>
                      <p className="text-sm font-semibold text-emerald-400">
                        {formatUSDC(repaid)} USDC
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">Remaining Balance</p>
                      <p className="text-sm font-semibold text-amber-400">
                        {formatUSDC(remaining)} USDC
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">Status</p>
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${
                          isRepaid
                            ? "bg-emerald-500/20 text-emerald-400"
                            : "bg-indigo-500/20 text-indigo-400"
                        }`}
                      >
                        {isRepaid ? "Repaid" : loan.status}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* ── Repayment Schedule ── */}
            <section aria-labelledby="schedule-heading" className="mb-8 animate-fade-in-up-delay-1">
              <h2 id="schedule-heading" className="text-lg font-semibold mb-4">
                Repayment Schedule
              </h2>

              {schedule ? (
                <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <p className="text-sm text-[var(--text-muted)]">
                        Monthly installment:{" "}
                        <strong className="text-[var(--text-primary)]">
                          {formatUSDC(schedule.monthlyAmount)} USDC
                        </strong>
                      </p>
                      <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        {schedule.paymentsMade} of {schedule.durationMonths} payments made
                      </p>
                    </div>
                    <div className="text-right text-xs text-[var(--text-muted)]">
                      <span className="inline-flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                        Completed
                      </span>
                      <span className="inline-flex items-center gap-1 ml-3">
                        <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]" />
                        Current
                      </span>
                    </div>
                  </div>

                  {/* Timeline */}
                  <div className="space-y-0">
                    {Array.from({ length: schedule.durationMonths }, (_, i) => {
                      const isCompleted = i < schedule.paymentsMade;
                      const isCurrent = i === schedule.paymentsMade && !isRepaid;
                      return (
                        <div key={i} className="flex items-center gap-3 py-2.5">
                          {/* Timeline dot */}
                          <div className="flex-shrink-0 relative">
                            <div
                              className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-all ${
                                isCompleted
                                  ? "bg-emerald-500/20 border-emerald-500 text-emerald-400"
                                  : isCurrent
                                    ? "bg-indigo-500/20 border-[var(--accent-primary)] text-[var(--accent-primary)] animate-pulse-glow"
                                    : "bg-[var(--bg-primary)] border-[var(--border-color)] text-[var(--text-muted)]"
                              }`}
                            >
                              {isCompleted ? (
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                                </svg>
                              ) : (
                                i + 1
                              )}
                            </div>
                            {/* Connector line */}
                            {i < schedule.durationMonths - 1 && (
                              <div
                                className={`absolute top-8 left-1/2 -translate-x-1/2 w-0.5 h-6 ${
                                  isCompleted ? "bg-emerald-500/40" : "bg-[var(--border-color)]"
                                }`}
                              />
                            )}
                          </div>

                          {/* Month info */}
                          <div className="flex-1 flex items-center justify-between">
                            <div>
                              <p
                                className={`text-sm ${
                                  isCurrent
                                    ? "font-semibold text-[var(--accent-primary)]"
                                    : "text-[var(--text-secondary)]"
                                }`}
                              >
                                Month {i + 1}
                              </p>
                              <p className="text-xs text-[var(--text-muted)]">
                                {formatUSDC(schedule.monthlyAmount)} USDC
                              </p>
                            </div>
                            {isCurrent && (
                              <span className="text-xs font-medium text-[var(--accent-primary)] bg-indigo-500/10 px-2 py-0.5 rounded">
                                Due Now
                              </span>
                            )}
                            {isCompleted && (
                              <span className="text-xs text-emerald-400">Paid</span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="p-6 bg-[var(--bg-card)] rounded-lg text-sm text-[var(--text-muted)]">
                  No repayment schedule available.
                </div>
              )}
            </section>

            {/* ── Make Payment ── */}
            {!isRepaid && (
              <section aria-labelledby="payment-heading" className="mb-8 animate-fade-in-up-delay-2">
                <h2 id="payment-heading" className="text-lg font-semibold mb-4">
                  Make a Payment
                </h2>

                <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
                  {!isConnected ? (
                    <div className="text-center py-6">
                      <p className="text-sm text-[var(--text-secondary)] mb-4">
                        Connect your Freighter wallet to make a payment.
                      </p>
                      <button
                        onClick={() => connect()}
                        className="btn-primary !py-2.5 !px-5"
                      >
                        Connect Wallet
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={handleRepay} className="space-y-4">
                      <div>
                        <label
                          htmlFor="repay-amount"
                          className="block text-sm font-medium text-[var(--text-secondary)] mb-1"
                        >
                          Amount (USDC)
                        </label>
                        <div className="relative">
                          <input
                            id="repay-amount"
                            type="number"
                            min="0.01"
                            step="0.01"
                            placeholder="0.00"
                            value={payAmount}
                            onChange={(e) => setPayAmount(e.target.value)}
                            className="w-full p-3 pr-20 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] text-lg font-semibold tabular-nums outline-none focus:border-[var(--accent-primary)] transition-colors"
                            aria-describedby="pay-error"
                          />
                          {schedule && schedule.monthlyAmount > 0 && (
                            <button
                              type="button"
                              onClick={() => setPayAmount(formatUSDC(schedule.monthlyAmount))}
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs px-2 py-1 rounded bg-[var(--accent-primary)]/10 text-[var(--accent-primary-light)] hover:bg-[var(--accent-primary)]/20 transition-colors"
                            >
                              Suggested
                            </button>
                          )}
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-1">
                          Remaining balance: {formatUSDC(remaining)} USDC
                        </p>
                      </div>

                      {payError && (
                        <p id="pay-error" role="alert" className="text-sm text-red-400">
                          {payError}
                        </p>
                      )}

                      {paySuccess && (
                        <p role="status" className="text-sm text-emerald-400">
                          Payment submitted successfully.
                        </p>
                      )}

                      <button
                        type="submit"
                        disabled={paying || remaining <= 0}
                        className="btn-primary w-full"
                        aria-busy={paying}
                      >
                        {paying ? "Signing transaction\u2026" : `Repay ${formatUSDC(payAmount || 0)} USDC`}
                      </button>
                    </form>
                  )}
                </div>
              </section>
            )}

            {/* ── Transaction History ── */}
            <section aria-labelledby="history-heading" className="animate-fade-in-up-delay-3">
              <h2 id="history-heading" className="text-lg font-semibold mb-4">
                Repayment History
              </h2>

              {historyLoading && (
                <div className="p-6 bg-[var(--bg-card)] rounded-lg text-sm text-[var(--text-muted)]">
                  Loading transaction history{"\u2026"}
                </div>
              )}

              {historyError && !historyLoading && (
                <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
                  {historyError}
                </div>
              )}

              {!historyLoading && !historyError && (
                <>
                  {records.length === 0 ? (
                    <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] text-sm text-[var(--text-muted)] text-center">
                      No repayment transactions found.
                    </div>
                  ) : (
                    <div className="bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] overflow-hidden">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)] text-xs uppercase tracking-wider">
                              <th className="px-5 py-3 text-left font-medium">Date</th>
                              <th className="px-5 py-3 text-right font-medium">Amount</th>
                              <th className="px-5 py-3 text-left font-medium">Transaction</th>
                            </tr>
                          </thead>
                          <tbody>
                            {records.map((tx) => (
                              <tr
                                key={tx.id}
                                className="border-b border-[var(--border-color)]/40 last:border-0 hover:bg-[var(--bg-card-hover)] transition-colors"
                              >
                                <td className="px-5 py-4 text-[var(--text-secondary)] whitespace-nowrap">
                                  {formatDate(tx.date)}
                                </td>
                                <td className="px-5 py-4 text-right font-medium tabular-nums">
                                  <span className="text-emerald-400">
                                    {'\u2212'}{tx.amount} USDC
                                  </span>
                                </td>
                                <td className="px-5 py-4">
                                  <a
                                    href={`${STELLARCHAIN_TX_BASE}${tx.hash}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono text-[var(--accent-primary-light)] hover:underline text-xs"
                                    title={tx.hash}
                                  >
                                    {shorten(tx.hash)}
                                  </a>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="px-5 py-3 border-t border-[var(--border-color)] text-xs text-[var(--text-muted)]">
                        Showing {records.length} repayment transaction{records.length !== 1 ? "s" : ""}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}

        {/* ── No loan state ── */}
        {!loading && !error && loan && loan.status === "none" && (
          <div className="p-10 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] text-center">
            <div className="text-4xl mb-4">{'\u{1F3E0}'}</div>
            <h2 className="text-lg font-semibold mb-2">No Active Loan</h2>
            <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
              You do not have an active loan to repay. Complete the onboarding process and apply
              for a loan through the dashboard.
            </p>
            <a href="/dashboard" className="btn-primary inline-flex mt-6 !py-2.5 !px-5">
              Go to Dashboard
            </a>
          </div>
        )}
      </main>
    </div>
  );
}

// ── Page Export ─────────────────────────────────────────────────────────────

export default function RepayPage() {
  return (
    <WalletProvider>
      <RepayInner />
    </WalletProvider>
  );
}
