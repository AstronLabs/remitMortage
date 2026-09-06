"use client";

import React, { useEffect, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { useWallet, OptionalWalletProvider } from "../../context/WalletContext";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });
import ROIProjectionWidget from "../../components/ROIProjectionWidget";
import { useGovernanceProposals, type GovernanceProposal } from "../../hooks/useGovernanceProposals";
import { GovernanceVotingModal } from "../../components/governance/GovernanceVotingModal";
import { SubmitProposalModal } from "../../components/governance/SubmitProposalModal";
import { QuorumProgressBar } from "../../components/governance/QuorumProgressBar";
import { track } from "../../lib/analytics";

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

interface PoolRates {
  poolApyBps: number;
  seniorApyBps: number;
  juniorApyBps: number;
  /** Whether these figures came from a live lending-pool contract read. */
  live: boolean;
}

function formatUSDC(raw: string | number): string {
  const n = typeof raw === "string" ? parseFloat(raw) : raw;
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bpsToPercent(bps: number): string {
  return (bps / 100).toFixed(1) + "%";
}

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
    <div className="p-5 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl flex flex-col justify-between">
      <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">{label}</p>
      <p
        className="text-2xl font-extrabold text-white font-mono"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </p>
      {sub && <p className="text-xs text-slate-500 mt-1">{sub}</p>}
    </div>
  );
}

function UtilizationGauge({ rate }: { rate: number }) {
  const pct = Math.min(100, Math.round(rate * 100));
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-300 font-semibold mb-1">
        <span>Pool Utilization</span>
        <span className="text-cyan-400 font-mono">{pct}%</span>
      </div>
      <div className="w-full bg-slate-950 rounded-full h-2.5 border border-slate-800 overflow-hidden">
        <div
          className="h-2.5 rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500 transition-all duration-700"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function InvestPage() {
  return (
    <OptionalWalletProvider>
      <InvestPageInner />
    </OptionalWalletProvider>
  );
}

function InvestPageInner() {
  const { publicKey, isConnected, connect } = useWallet();

  useEffect(() => {
    if (isConnected) track("portfolio_viewed");
  }, [isConnected]);

  const [metrics, setMetrics] = useState<PoolMetrics | null>(null);
  const [position, setPosition] = useState<InvestorPosition | null>(null);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  // Rate feed sourced from the lending-pool contract's on-chain config
  // (falls back to a static estimate if the contract read is unavailable).
  const [poolRates, setPoolRates] = useState<PoolRates | null>(null);

  const [depositAmount, setDepositAmount] = useState("");
  const [selectedTranche, setSelectedTranche] = useState<Tranche>("Senior");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [depositing, setDepositing] = useState(false);
  const [depositSuccess, setDepositSuccess] = useState(false);

  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const { proposals, loading: loadingProposals, error: proposalsError, submitVote, createProposal } = useGovernanceProposals();
  const [selectedProposal, setSelectedProposal] = useState<GovernanceProposal | null>(null);
  const [isSubmitModalOpen, setIsSubmitModalOpen] = useState(false);

  const loadMetrics = useCallback(async () => {
    setLoadingMetrics(true);
    setMetricsError(null);
    try {
      const placeholder: PoolMetrics = {
        totalLiquidity: "1250000",
        seniorLiquidity: "875000",
        juniorLiquidity: "375000",
        activeLoans: 3,
        utilizationRate: 0.56,
        estimatedApyBps: 620,
        defaultRate: 0.0,
      };

      // Rates come from the deployed lending-pool contract's config rather
      // than a hardcoded estimate; the route degrades to a static fallback
      // if the contract read is unavailable, so this never throws.
      const ratesRes = await fetch("/api/investor/pool-rate");
      const rates: PoolRates = await ratesRes.json();
      setPoolRates(rates);

      setMetrics({ ...placeholder, estimatedApyBps: rates.poolApyBps });

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
      `Confirm deposit of ${formatUSDC(amount)} USDC into the ${selectedTranche} tranche?`
    );
    if (!confirmed) return;

    track("investment_started", { tranche: selectedTranche });
    setDepositing(true);
    try {
      await new Promise((r) => setTimeout(r, 1000));

      setPosition((prev: InvestorPosition | null) => ({
        deposited: String((parseFloat(prev?.deposited ?? "0") + amount).toFixed(2)),
        tranche: prev?.tranche ?? selectedTranche,
        accruedYield: prev?.accruedYield ?? "0",
        startLedger: prev?.startLedger ?? 0,
      }));

      setDepositAmount("");
      setDepositSuccess(true);
      track("investment_completed", { tranche: selectedTranche });
      setTimeout(() => setDepositSuccess(false), 5000);
    } catch (err: any) {
      setDepositError(err?.message || "Deposit transaction failed.");
    } finally {
      setDepositing(false);
    }
  }

  async function handleWithdraw() {
    setWithdrawError(null);

    if (!position || parseFloat(position.deposited) <= 0) {
      setWithdrawError("No balance to withdraw.");
      return;
    }

    if (metrics) {
      const afterWithdraw = parseFloat(metrics.totalLiquidity) - parseFloat(position.deposited);
      const activeCapital = parseFloat(metrics.totalLiquidity) * metrics.utilizationRate;
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
      await new Promise((r) => setTimeout(r, 800));
      setPosition({ deposited: "0", tranche: null, accruedYield: "0", startLedger: 0 });
      track("investment_withdrawal_completed");
    } catch (err: any) {
      setWithdrawError(err?.message || "Withdrawal failed.");
    } finally {
      setWithdrawing(false);
    }
  }

  // Fall back to a static estimate until the live rate feed resolves.
  const seniorApyBps = poolRates?.seniorApyBps ?? 400;
  const juniorApyBps =
    poolRates?.juniorApyBps ??
    (metrics ? Math.max(0, Math.round(metrics.estimatedApyBps * 2 - seniorApyBps)) : 0);

  return (
    <div className="rm-app-page rm-invest-page min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <main className="max-w-6xl mx-auto px-6 pt-32">
        <div className="mb-8">
          <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-semibold uppercase tracking-wider mb-4 border border-indigo-500/20">
            Lending Pool & Capital Tranches
          </span>
          <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-2">
            DeFi Investor <span className="gradient-text">Portal</span>
          </h1>
          <p className="text-slate-400 text-sm md:text-base max-w-2xl">
            Fund the 70% lending pool and earn yield from verified borrower mortgage repayments.
            Select Senior or Junior tranches based on your risk preference.
          </p>
        </div>

        {/* Pool Overview */}
        <section className="mb-10">
          <h2 className="text-lg font-bold text-white mb-4">Pool Overview</h2>

          {loadingMetrics && (
            <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl text-sm text-slate-400">
              Loading pool metrics…
            </div>
          )}

          {metricsError && (
            <div className="p-4 bg-red-500/10 text-red-300 border border-red-500/20 rounded-2xl text-sm">
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
                  sub={poolRates?.live ? "live · on-chain" : "weighted avg"}
                  accent="#38bdf8"
                />
                <MetricCard
                  label="Default Rate"
                  value={`${(metrics.defaultRate * 100).toFixed(1)}%`}
                  sub="historical"
                  accent="#10b981"
                />
              </div>

              {/* Health Indicators */}
              <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl space-y-5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                  Pool Health & Liquidity Split
                </h3>
                <UtilizationGauge rate={metrics.utilizationRate} />

                <div>
                  <div className="flex justify-between text-xs text-slate-300 font-semibold mb-1">
                    <span>
                      Senior Tranche:{" "}
                      <span className="text-indigo-400 font-mono">
                        ${formatUSDC(metrics.seniorLiquidity)}
                      </span>
                    </span>
                    <span>
                      Junior Tranche:{" "}
                      <span className="text-cyan-400 font-mono">
                        ${formatUSDC(metrics.juniorLiquidity)}
                      </span>
                    </span>
                  </div>
                  <div className="flex h-3 rounded-full overflow-hidden bg-slate-950 border border-slate-800">
                    {parseFloat(metrics.totalLiquidity) > 0 && (
                      <>
                        <div
                          className="bg-indigo-500"
                          style={{
                            width: `${(parseFloat(metrics.seniorLiquidity) / parseFloat(metrics.totalLiquidity)) * 100}%`,
                          }}
                        />
                        <div
                          className="bg-cyan-400"
                          style={{
                            width: `${(parseFloat(metrics.juniorLiquidity) / parseFloat(metrics.totalLiquidity)) * 100}%`,
                          }}
                        />
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Deposit Form */}
          <section>
            <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl space-y-5">
              <h2 className="text-lg font-bold text-white">Deposit USDC</h2>

              {!isConnected ? (
                <div className="text-center py-6">
                  <p className="text-xs text-slate-400 mb-4">
                    Connect your Freighter wallet to supply liquidity.
                  </p>
                  <button onClick={() => connect()} className="btn-cta py-2.5 px-5 !text-xs">
                    Connect Wallet
                  </button>
                </div>
              ) : (
                <form onSubmit={handleDeposit} className="space-y-4">
                  <div>
                    <label className="text-xs font-bold uppercase text-slate-400 block mb-2">
                      Select Capital Tranche
                    </label>
                    <div className="grid grid-cols-2 gap-3">
                      {(["Senior", "Junior"] as Tranche[]).map((t) => (
                        <label
                          key={t}
                          className={`cursor-pointer rounded-xl border p-4 text-xs transition-all ${
                            selectedTranche === t
                              ? "border-cyan-400 bg-cyan-500/10 text-white"
                              : "border-slate-800 text-slate-400 hover:border-slate-700"
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
                          <div className="font-bold text-sm text-white mb-1">{t} Tranche</div>
                          <div className="text-[11px] leading-relaxed">
                            {t === "Senior" ? (
                              <>
                                <span className="text-indigo-400 font-bold font-mono">
                                  ~{bpsToPercent(seniorApyBps)} Fixed APY
                                </span>
                                <br />
                                Protected capital
                              </>
                            ) : (
                              <>
                                <span className="text-cyan-400 font-bold font-mono">
                                  ~{bpsToPercent(juniorApyBps)} Est. APY
                                </span>
                                <br />
                                Absorbs first loss
                              </>
                            )}
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="deposit-amount"
                      className="block text-xs font-bold uppercase text-slate-400 mb-1"
                    >
                      Deposit Amount (USDC)
                    </label>
                    <input
                      id="deposit-amount"
                      type="number"
                      min="1"
                      step="0.01"
                      placeholder="e.g. 5000"
                      value={depositAmount}
                      onChange={(e) => setDepositAmount(e.target.value)}
                      className="input-field font-mono"
                    />
                  </div>

                  {depositError && <p className="text-xs text-red-400">{depositError}</p>}
                  {depositSuccess && (
                    <p className="text-xs text-emerald-400">Deposit submitted successfully.</p>
                  )}

                  <button
                    type="submit"
                    disabled={depositing}
                    className="btn-cta w-full justify-center py-3"
                  >
                    {depositing
                      ? "Signing Transaction..."
                      : `Deposit into ${selectedTranche} Tranche`}
                  </button>
                </form>
              )}
            </div>
          </section>

          {/* My Position */}
          <section>
            <div className="p-6 bg-slate-900/80 rounded-2xl border border-slate-800 backdrop-blur-xl h-full flex flex-col justify-between">
              <div>
                <h2 className="text-lg font-bold text-white mb-4">My Position</h2>

                {!isConnected ? (
                  <p className="text-xs text-slate-500">Connect wallet to view portfolio status.</p>
                ) : position ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                        <p className="text-[10px] text-slate-500 font-bold uppercase">Deposited</p>
                        <p className="text-xl font-extrabold text-white font-mono mt-1">
                          ${formatUSDC(position.deposited)}
                        </p>
                      </div>
                      <div className="bg-slate-950/60 border border-slate-800 rounded-xl p-4">
                        <p className="text-[10px] text-slate-500 font-bold uppercase">
                          Earned Yield
                        </p>
                        <p className="text-xl font-extrabold text-emerald-400 font-mono mt-1">
                          ${formatUSDC(position.accruedYield)}
                        </p>
                      </div>
                    </div>

                    {position.tranche && (
                      <div className="flex items-center gap-2 text-xs">
                        <span className="text-slate-400">Active Tranche:</span>
                        <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
                          {position.tranche}
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-xs text-slate-500">Loading position…</p>
                )}
              </div>

              {isConnected && position && (
                <div className="pt-4 border-t border-slate-800 mt-6">
                  {withdrawError && <p className="text-xs text-red-400 mb-2">{withdrawError}</p>}
                  <button
                    onClick={handleWithdraw}
                    disabled={withdrawing || parseFloat(position.deposited) <= 0}
                    className="btn-outline w-full justify-center text-xs py-2.5 disabled:opacity-40"
                  >
                    {withdrawing ? "Processing…" : "Withdraw Liquidity"}
                  </button>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Governance Section */}
        <section className="mb-10 mt-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white">Active Protocol Proposals</h2>
            <button 
              onClick={() => setIsSubmitModalOpen(true)}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-lg border border-slate-700 transition-colors"
            >
              + New Proposal
            </button>
          </div>
          
          {loadingProposals ? (
            <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl text-sm text-slate-400 animate-pulse">
              Loading active proposals...
            </div>
          ) : proposalsError ? (
            <div className="p-4 bg-red-500/10 text-red-300 border border-red-500/20 rounded-2xl text-sm">
              Failed to load proposals.
            </div>
          ) : proposals.length === 0 ? (
             <div className="p-6 bg-slate-900 border border-slate-800 rounded-2xl text-sm text-slate-400 text-center">
               No active proposals at this time.
             </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {proposals.map((p) => (
                <div key={p.id} className="p-5 bg-slate-900/80 rounded-2xl border border-slate-800 hover:border-slate-700 transition-colors flex flex-col justify-between">
                  <div>
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-white line-clamp-1 pr-4">{p.title}</h3>
                      <span className={`shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${
                        p.status === "approved"
                          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                          : "bg-cyan-500/10 text-cyan-400 border border-cyan-500/20"
                      }`}>
                        {p.status}
                      </span>
                    </div>
                    <p className="text-sm text-slate-400 mb-4 line-clamp-2">{p.description}</p>
                    <QuorumProgressBar 
                      currentVotes={p.currentVotes}
                      requiredVotes={p.requiredVotes}
                      quorumThresholdPercent={p.quorumPercent}
                    />
                  </div>
                  <button 
                    onClick={() => setSelectedProposal(p)}
                    className="mt-4 w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-bold rounded-xl border border-slate-700 transition-colors"
                  >
                    View & Vote
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Modals */}
        <GovernanceVotingModal
          isOpen={!!selectedProposal}
          onClose={() => setSelectedProposal(null)}
          proposal={selectedProposal}
          onVote={submitVote}
        />
        <SubmitProposalModal
          isOpen={isSubmitModalOpen}
          onClose={() => setIsSubmitModalOpen(false)}
          onSubmit={createProposal}
        />


        {isConnected && publicKey && position && parseFloat(position.deposited) > 0 && (
          <ROIProjectionWidget
            wallet={publicKey}
            depositedAmount={parseFloat(position.deposited)}
            apyBps={position.tranche === "Senior" ? seniorApyBps : juniorApyBps}
          />
        )}
      </main>
    </div>
  );
}
