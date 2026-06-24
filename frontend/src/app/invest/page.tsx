"use client";

import React, { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useWallet, WalletProvider } from "../../context/WalletContext";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

// ── Types ──────────────────────────────────────────────────────────────────

type Tranche = "Senior" | "Junior";

interface PoolMetrics {
  totalLiquidity: string;
  seniorLiquidity: string;
  juniorLiquidity: string;
  activeLoans: number;
  utilizationRate: number; // 0–1
  estimatedApyBps: number; // basis points
  defaultRate: number; // 0–1
}

interface InvestorPosition {
  deposited: string;
  tranche: Tranche | null;
  accruedYield: string;
  startLedger: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatUSDC(raw: string | number): string {
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(1) + "%";
}

function utilizationColor(rate: number): string {
  if (rate < 0.6) return "#16a34a";
  if (rate < 0.85) return "#d97706";
  return "#dc2626";
}

// ── Sub-components ───────────────────────────────────────────────────────────

function MetricCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: string;
}) {
  return (
    <div className="p-5 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
      <p className="text-xs text-[var(--text-muted)] mb-1">{label}</p>
      <p
        className="text-2xl font-bold"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-[var(--text-secondary)] mt-1">{sub}</p>}
    </div>
  );
}

function UtilizationGauge({ rate }: { rate: number }) {
  const pct = Math.min(100, Math.round(rate * 100));
  const color = utilizationColor(rate);
  return (
    <div>
      <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
        <span>Utilization</span>
        <span style={{ color }}>{pct}%</span>
      </div>
      <div className="w-full bg-[var(--bg-primary)] rounded-full h-2">
        <div
          className="h-2 rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function InvestPage() {
  return (
    <WalletProvider>
      <InvestPageInner />
    </WalletProvider>
  );
}

function InvestPageInner() {
  const { publicKey, isConnected, connect } = useWallet();

  const [metrics, setMetrics] = useState<PoolMetrics | null>(null);
  const [position, setPosition] = useState<InvestorPosition | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  // Deposit form state.
  const [depositAmount, setDepositAmount] = useState("");
  const [selectedTranche, setSelectedTranche] = useState<Tranche>("Senior");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositing, setDepositing] = useState(false);
  const [depositSuccess, setDepositSuccess] = useState(false);

  // Withdraw state.
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  // Load on-chain pool metrics from the backend.
  // NOTE: Currently uses placeholder data until the Soroban query layer is wired.
  const loadMetrics = useCallback(async () => {
    setLoadingMetrics(true);
    setMetricsError(null);
    try {
      // TODO: Replace with real backend endpoints once Soroban queries are integrated.
      // Placeholder values that would come from GET /api/pool/metrics.
      const placeholder: PoolMetrics = {
        totalLiquidity: "1250000",
        seniorLiquidity: "875000",
        juniorLiquidity: "375000",
        activeLoans: 3,
        utilizationRate: 0.56,
        estimatedApyBps: 620, // weighted average of tranche yields
        defaultRate: 0.0,
      };
      setMetrics(placeholder);

      // TODO: Replace with real backend endpoint GET /api/pool/investor/:address
      if (publicKey) {
        const investorPlaceholder: InvestorPosition = {
          deposited: "0",
          tranche: null,
          accruedYield: "0",
          startLedger: 0,
        };
        setPosition(investorPlaceholder);
      }
    } catch (e: any) {
      setMetricsError(e?.message || "Failed to load pool metrics");
    } finally {
      setLoadingMetrics(false);
    }
  }, [publicKey]);

  useEffect(() => {
    loadMetrics();
  }, [loadMetrics]);

  // ── Deposit handler ──────────────────────────────────────────────────
  async function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    setDepositError(null);
    setDepositSuccess(false);

    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) {
      setDepositError("Enter a valid positive USDC amount.");
      return;
    }

    if (!isConnected || !publicKey) {
      setDepositError("Connect your wallet first.");
      return;
    }

    const confirmed = confirm(
      `Confirm deposit of ${formatUSDC(amount)} USDC into the ${selectedTranche} tranche?\n\n` +
        (selectedTranche === "Senior"
          ? "Senior: ~4% fixed APY — protected capital, lower risk."
          : "Junior: Variable higher yield — absorbs first losses, higher risk.")
    );
    if (!confirmed) return;

    setDepositing(true);
    try {
      // TODO: Build and submit actual Soroban transaction via Freighter:
      //   lending_pool::deposit(publicKey, amount_stroops, Tranche::Senior|Junior)
      await new Promise((r) => setTimeout(r, 1000));

      // Optimistically update position for demo.
      setPosition((prev: InvestorPosition | null) => ({
        deposited: String((parseFloat(prev?.deposited ?? "0") + amount).toFixed(2)),
        tranche: prev?.tranche ?? selectedTranche,
        accruedYield: prev?.accruedYield ?? "0",
        startLedger: prev?.startLedger ?? 0,
      }));

      setDepositAmount("");
      setDepositSuccess(true);
      setTimeout(() => setDepositSuccess(false), 5000);
    } catch (err: any) {
      setDepositError(err?.message || "Deposit transaction failed.");
    } finally {
      setDepositing(false);
    }
  }

  // ── Withdraw handler ─────────────────────────────────────────────────
  async function handleWithdraw() {
    setWithdrawError(null);

    if (!position || parseFloat(position.deposited) <= 0) {
      setWithdrawError("No balance to withdraw.");
      return;
    }

    // Guard against withdrawing when it would leave active loans uncovered.
    if (metrics) {
      const afterWithdraw =
        parseFloat(metrics.totalLiquidity) - parseFloat(position.deposited);
      const activeCapital =
        parseFloat(metrics.totalLiquidity) * metrics.utilizationRate;
      if (afterWithdraw < activeCapital) {
        setWithdrawError(
          "Withdrawal blocked: insufficient remaining liquidity to cover active loans."
        );
        return;
      }
    }

    const confirmed = confirm(
      `Withdraw your ${formatUSDC(position.deposited)} USDC from the ${position.tranche} tranche?`
    );
    if (!confirmed) return;

    setWithdrawing(true);
    try {
      // TODO: Call lending_pool::withdraw() via Freighter.
      await new Promise((r) => setTimeout(r, 800));
      setPosition({ deposited: "0", tranche: null, accruedYield: "0", startLedger: 0 });
    } catch (err: any) {
      setWithdrawError(err?.message || "Withdrawal failed.");
    } finally {
      setWithdrawing(false);
    }
  }

  // ── Senior vs Junior yield display ──────────────────────────────────
  const seniorApyBps = 400; // fixed 4%
  const juniorApyBps = metrics
    ? Math.max(0, Math.round(metrics.estimatedApyBps * 2 - seniorApyBps))
    : 0;

  return (
    <div>
      <Navbar />

      <main className="max-w-5xl mx-auto px-6 py-24">
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Investor Portal</h1>
          <p className="text-[var(--text-secondary)]">
            Deposit capital into the RemitMortgage lending pool and earn yield
            from borrower repayments. Choose your tranche to match your risk
            appetite.
          </p>
        </div>

        {/* ── Pool Overview ── */}
        <section aria-labelledby="pool-overview-heading" className="mb-10">
          <h2
            id="pool-overview-heading"
            className="text-lg font-semibold mb-4"
          >
            Pool Overview
          </h2>

          {loadingMetrics && (
            <div className="p-6 bg-[var(--bg-card)] rounded-lg text-sm text-[var(--text-muted)]">
              Loading pool metrics…
            </div>
          )}

          {metricsError && (
            <div
              role="alert"
              className="p-4 bg-red-50 text-red-700 rounded-lg text-sm"
            >
              {metricsError}
            </div>
          )}

          {metrics && !loadingMetrics && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <MetricCard
                  label="Total Pool Liquidity"
                  value={`$${formatUSDC(metrics.totalLiquidity)}`}
                  sub="USDC available"
                />
                <MetricCard
                  label="Active Loans"
                  value={String(metrics.activeLoans)}
                  sub="funded borrowers"
                />
                <MetricCard
                  label="Estimated Pool APY"
                  value={bpsToPercent(metrics.estimatedApyBps)}
                  sub="weighted avg"
                  accent="#6366f1"
                />
                <MetricCard
                  label="Default Rate"
                  value={`${(metrics.defaultRate * 100).toFixed(1)}%`}
                  sub="historical"
                  accent={metrics.defaultRate > 0.05 ? "#dc2626" : "#16a34a"}
                />
              </div>

              {/* Health Indicators */}
              <div className="p-5 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] space-y-4">
                <h3 className="text-sm font-semibold text-[var(--text-secondary)]">
                  Pool Health Indicators
                </h3>
                <UtilizationGauge rate={metrics.utilizationRate} />

                {/* Tranche split bar */}
                <div>
                  <div className="flex justify-between text-xs text-[var(--text-muted)] mb-1">
                    <span>
                      Senior{" "}
                      <span className="text-indigo-400">
                        ${formatUSDC(metrics.seniorLiquidity)}
                      </span>
                    </span>
                    <span>
                      Junior{" "}
                      <span className="text-cyan-400">
                        ${formatUSDC(metrics.juniorLiquidity)}
                      </span>
                    </span>
                  </div>
                  <div className="flex h-2 rounded-full overflow-hidden">
                    {parseFloat(metrics.totalLiquidity) > 0 && (
                      <>
                        <div
                          className="bg-indigo-500"
                          style={{
                            width: `${(parseFloat(metrics.seniorLiquidity) / parseFloat(metrics.totalLiquidity)) * 100}%`,
                          }}
                        />
                        <div
                          className="bg-cyan-500"
                          style={{
                            width: `${(parseFloat(metrics.juniorLiquidity) / parseFloat(metrics.totalLiquidity)) * 100}%`,
                          }}
                        />
                      </>
                    )}
                  </div>
                </div>

                {/* APY rows */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="text-xs">
                    <span className="text-[var(--text-muted)]">
                      Senior APY (fixed):{" "}
                    </span>
                    <span className="font-semibold text-indigo-400">
                      {bpsToPercent(seniorApyBps)}
                    </span>
                  </div>
                  <div className="text-xs">
                    <span className="text-[var(--text-muted)]">
                      Junior APY (est.):{" "}
                    </span>
                    <span className="font-semibold text-cyan-400">
                      {bpsToPercent(juniorApyBps)}
                    </span>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <div className="grid md:grid-cols-2 gap-6">
          {/* ── Deposit Form ── */}
          <section aria-labelledby="deposit-heading">
            <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
              <h2 id="deposit-heading" className="text-lg font-semibold mb-4">
                Deposit USDC
              </h2>

              {!isConnected ? (
                <div className="text-center py-6">
                  <p className="text-sm text-[var(--text-secondary)] mb-4">
                    Connect your Freighter wallet to deposit.
                  </p>
                  <button
                    onClick={() => connect()}
                    className="btn-primary !py-2.5 !px-5"
                  >
                    Connect Wallet
                  </button>
                </div>
              ) : (
                <form onSubmit={handleDeposit} className="space-y-4">
                  {/* Tranche selector */}
                  <fieldset>
                    <legend className="text-sm font-medium text-[var(--text-secondary)] mb-2">
                      Select Tranche
                    </legend>
                    <div className="grid grid-cols-2 gap-3">
                      {(["Senior", "Junior"] as Tranche[]).map((t) => (
                        <label
                          key={t}
                          className={`cursor-pointer rounded-lg border p-3 text-sm transition-all ${
                            selectedTranche === t
                              ? "border-indigo-500 bg-indigo-500/10 text-[var(--text-primary)]"
                              : "border-[var(--border-color)] text-[var(--text-muted)] hover:border-indigo-400"
                          }`}
                        >
                          <input
                            type="radio"
                            name="tranche"
                            value={t}
                            checked={selectedTranche === t}
                            onChange={() => setSelectedTranche(t)}
                            className="sr-only"
                          />
                          <div className="font-semibold mb-0.5">{t}</div>
                          <div className="text-xs">
                            {t === "Senior" ? (
                              <>
                                ~{bpsToPercent(seniorApyBps)} fixed APY
                                <br />
                                Protected capital
                              </>
                            ) : (
                              <>
                                ~{bpsToPercent(juniorApyBps)} est. APY
                                <br />
                                Absorbs first losses
                              </>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  {/* Amount input */}
                  <div>
                    <label
                      htmlFor="deposit-amount"
                      className="block text-sm font-medium text-[var(--text-secondary)] mb-1"
                    >
                      Amount (USDC)
                    </label>
                    <input
                      id="deposit-amount"
                      type="number"
                      min="1"
                      step="0.01"
                      placeholder="e.g. 5000"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="w-full p-2.5 rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] text-sm"
                      aria-describedby="deposit-error"
                    />
                  </div>

                  {depositError && (
                    <p
                      id="deposit-error"
                      role="alert"
                      className="text-sm text-red-500"
                    >
                      {depositError}
                    </p>
                  )}

                  {depositSuccess && (
                    <p
                      role="status"
                      className="text-sm text-green-500"
                    >
                      Deposit submitted successfully.
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={depositing}
                    className="btn-primary w-full"
                    aria-busy={depositing}
                  >
                    {depositing ? "Signing transaction…" : `Deposit into ${selectedTranche} Tranche`}
                  </button>
                </form>
              )}
            </div>
          </section>

          {/* ── My Position ── */}
          <section aria-labelledby="position-heading">
            <div className="p-6 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] h-full flex flex-col">
              <h2
                id="position-heading"
                className="text-lg font-semibold mb-4"
              >
                My Position
              </h2>

              {!isConnected ? (
                <p className="text-sm text-[var(--text-muted)] flex-1">
                  Connect your wallet to view your position.
                </p>
              ) : position ? (
                <div className="flex-1 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[var(--bg-primary)] rounded-lg p-3">
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">
                        Deposited
                      </p>
                      <p className="text-lg font-bold">
                        ${formatUSDC(position.deposited)}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)]">
                        USDC
                      </p>
                    </div>
                    <div className="bg-[var(--bg-primary)] rounded-lg p-3">
                      <p className="text-xs text-[var(--text-muted)] mb-0.5">
                        Earned Yield
                      </p>
                      <p className="text-lg font-bold text-green-400">
                        ${formatUSDC(position.accruedYield)}
                      </p>
                      <p className="text-xs text-[var(--text-secondary)]">
                        USDC
                      </p>
                    </div>
                  </div>

                  {position.tranche && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-[var(--text-muted)]">Tranche:</span>
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-semibold ${
                          position.tranche === "Senior"
                            ? "bg-indigo-500/20 text-indigo-400"
                            : "bg-cyan-500/20 text-cyan-400"
                        }`}
                      >
                        {position.tranche}
                      </span>
                      <span className="text-[var(--text-muted)] text-xs">
                        {position.tranche === "Senior"
                          ? `~${bpsToPercent(seniorApyBps)} APY`
                          : `~${bpsToPercent(juniorApyBps)} APY`}
                      </span>
                    </div>
                  )}

                  {/* Yield tracker */}
                  {metrics && parseFloat(position.deposited) > 0 && (
                    <div className="bg-[var(--bg-primary)] rounded-lg p-3 text-xs space-y-1">
                      <p className="font-medium text-[var(--text-secondary)]">
                        Yield Estimate
                      </p>
                      <p className="text-[var(--text-muted)]">
                        Annual (current APY):{" "}
                        <strong className="text-[var(--text-primary)]">
                          $
                          {formatUSDC(
                            (parseFloat(position.deposited) *
                              (position.tranche === "Senior"
                                ? seniorApyBps
                                : juniorApyBps)) /
                              10_000
                          )}
                        </strong>
                      </p>
                      <p className="text-[var(--text-muted)]">
                        Pool utilization:{" "}
                        <strong
                          style={{ color: utilizationColor(metrics.utilizationRate) }}
                        >
                          {Math.round(metrics.utilizationRate * 100)}%
                        </strong>
                      </p>
                    </div>
                  )}

                  {/* Withdraw */}
                  <div className="mt-auto pt-2">
                    {withdrawError && (
                      <p
                        role="alert"
                        className="text-sm text-red-500 mb-2"
                      >
                        {withdrawError}
                      </p>
                    )}
                    <button
                      onClick={handleWithdraw}
                      disabled={
                        withdrawing ||
                        !position ||
                        parseFloat(position.deposited) <= 0
                      }
                      className="w-full py-2.5 px-4 rounded-lg border border-[var(--border-color)] text-sm font-medium
                        hover:border-red-400 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-busy={withdrawing}
                    >
                      {withdrawing ? "Processing…" : "Withdraw"}
                    </button>
                    <p className="text-xs text-[var(--text-muted)] mt-1 text-center">
                      Withdrawal blocked if it would leave active loans uncovered.
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-[var(--text-muted)]">
                  Loading position…
                </p>
              )}
            </div>
          </section>
        </div>

        {/* ── Tranche Info Cards ── */}
        <section aria-labelledby="tranche-info-heading" className="mt-8">
          <h2
            id="tranche-info-heading"
            className="text-lg font-semibold mb-4"
          >
            Tranche Structure
          </h2>
          <div className="grid md:grid-cols-2 gap-4">
            <div className="p-5 rounded-lg border border-indigo-500/30 bg-indigo-500/5">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-3 h-3 rounded-full bg-indigo-500" />
                <h3 className="font-semibold text-indigo-400">Senior Tranche</h3>
              </div>
              <ul className="text-sm text-[var(--text-secondary)] space-y-1.5">
                <li>→ Fixed {bpsToPercent(seniorApyBps)} annual yield</li>
                <li>→ Protected: junior absorbs losses first</li>
                <li>→ Lower risk, predictable income</li>
                <li>→ Ideal for risk-averse capital allocators</li>
              </ul>
            </div>
            <div className="p-5 rounded-lg border border-cyan-500/30 bg-cyan-500/5">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-3 h-3 rounded-full bg-cyan-500" />
                <h3 className="font-semibold text-cyan-400">Junior Tranche</h3>
              </div>
              <ul className="text-sm text-[var(--text-secondary)] space-y-1.5">
                <li>→ Variable yield — receives remaining interest</li>
                <li>→ First-loss position: absorbs defaults before senior</li>
                <li>→ Higher potential APY with higher risk</li>
                <li>→ Suited for yield-seeking participants</li>
              </ul>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
