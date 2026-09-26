"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useEffect, useState, useCallback, useRef, useMemo } from "react";
import dynamic from "next/dynamic";
import { ReceiptText } from "lucide-react";
import { Horizon } from "@stellar/stellar-sdk";
import { EmptyState } from "@/components/EmptyState";
import {
  createStatementMetadata,
  downloadStatementCsv,
  downloadStatementPdf,
  type StatementRow,
} from "@/lib/statementExport";
import useTransactionHistoryFilters, {
  type SortField,
  type TxCategory,
} from "@/hooks/useTransactionHistoryFilters";

const Navbar = dynamic(() => import("../../components/Navbar"), { ssr: false });

const HORIZON_TESTNET = "https://horizon-testnet.stellar.org";
const STELLARCHAIN_BASE = "https://testnet.stellarchain.io/transactions/";
const PAGE_SIZE = 20;

export type FilterPreset = {
  id: string;
  name: string;
  category: TxCategory;
  dateFrom: string;
  dateTo: string;
  amountMin: number;
  amountMax: number;
  sortField: SortField;
  sortDirection: "asc" | "desc";
};

type TxRecord = {
  id: string;
  date: string;
  category: Exclude<TxCategory, "All">;
  amount: string;
  status: "Success" | "Failed";
  hash: string;
  from: string;
  to: string;
};

const CATEGORY_OPTIONS: TxCategory[] = [
  "All",
  "Deposits",
  "Withdrawals",
  "Repayments",
  "Disbursements",
];

const CATEGORY_STYLES: Record<string, string> = {
  Deposits: "text-emerald-400 bg-emerald-400/10",
  Withdrawals: "text-amber-400 bg-amber-400/10",
  Repayments: "text-blue-400 bg-blue-400/10",
  Disbursements: "text-purple-400 bg-purple-400/10",
};

function shorten(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
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

function parsePaymentOp(op: any, publicKey: string): TxRecord | null {
  if (op.type !== "payment") return null;
  if (op.asset_code !== "USDC") return null;

  const isOutgoing = op.from === publicKey;
  const category: TxRecord["category"] = isOutgoing ? "Deposits" : "Disbursements";

  return {
    id: op.id,
    date: op.created_at,
    category,
    amount: parseFloat(op.amount).toFixed(2),
    status: "Success",
    hash: op.transaction_hash,
    from: op.from,
    to: op.to,
  };
}

export default function HistoryClient() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [walletChecked, setWalletChecked] = useState(false);

  const [records, setRecords] = useState<TxRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const cursorRef = useRef<string | null>(null);

  const { filters, updateFilters, setSortField } = useTransactionHistoryFilters(1000000);
  const sliderMaxRef = useRef(1000000);

  // Presets
  const [presets, setPresets] = useState<FilterPreset[]>([]);
  const [showPresetModal, setShowPresetModal] = useState(false);
  const [newPresetName, setNewPresetName] = useState("");
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [editingPresetName, setEditingPresetName] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem("remitmortgage_filter_presets");
      if (saved) {
        setPresets(JSON.parse(saved));
      }
    } catch (e) {}
  }, []);

  function savePresets(newPresets: FilterPreset[]) {
    setPresets(newPresets);
    try {
      localStorage.setItem("remitmortgage_filter_presets", JSON.stringify(newPresets));
    } catch (e) {}
  }

  function handleSavePreset() {
    if (!newPresetName.trim()) return;
    const newPreset: FilterPreset = {
      id: Date.now().toString(),
      name: newPresetName.trim(),
      category: filters.category,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      amountMin: filters.amountMin,
      amountMax: filters.amountMax,
      sortField: filters.sortField,
      sortDirection: filters.sortDirection,
    };
    savePresets([...presets, newPreset]);
    setNewPresetName("");
    setShowPresetModal(false);
  }

  function handleApplyPreset(preset: FilterPreset) {
    updateFilters({
      category: preset.category,
      dateFrom: preset.dateFrom,
      dateTo: preset.dateTo,
      amountMin: preset.amountMin,
      amountMax: preset.amountMax,
      sortField: preset.sortField,
      sortDirection: preset.sortDirection,
    });
  }

  function handleDeletePreset(id: string) {
    savePresets(presets.filter((p) => p.id !== id));
  }

  function handleRenamePreset(id: string) {
    if (!editingPresetName.trim()) return;
    savePresets(
      presets.map((p) =>
        p.id === id ? { ...p, name: editingPresetName.trim() } : p
      )
    );
    setEditingPresetId(null);
  }

  useEffect(() => {
    async function checkFreighter() {
      try {
        const win = window as any;
        const freighter =
          win.freighterApi ??
          (await import("@stellar/freighter-api").then((m) => m).catch(() => null));
        if (!freighter) return;

        let pk: string | null = null;
        if (typeof freighter.getPublicKey === "function") {
          pk = await freighter.getPublicKey().catch(() => null);
        } else if (typeof freighter.getAccount === "function") {
          pk = await freighter.getAccount().catch(() => null);
        }
        setPublicKey(pk);
      } catch {
        // Freighter not available or not connected
      } finally {
        setWalletChecked(true);
      }
    }
    checkFreighter();
  }, []);

  const fetchPage = useCallback(
    async (cursor?: string) => {
      if (!publicKey) return null;
      const server = new Horizon.Server(HORIZON_TESTNET);
      let query = server.payments().forAccount(publicKey).limit(PAGE_SIZE).order("desc");
      if (cursor) query = (query as any).cursor(cursor);
      return query.call();
    },
    [publicKey]
  );

  useEffect(() => {
    if (!publicKey) return;

    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setRecords([]);
      cursorRef.current = null;

      try {
        const result = await fetchPage();
        if (!result || cancelled) return;

        const parsed = (result.records as any[])
          .map((op) => parsePaymentOp(op, publicKey!))
          .filter(Boolean) as TxRecord[];

        setRecords(parsed);

        if (parsed.length > 0) {
          const maxAmt = Math.max(...parsed.map((r) => parseFloat(r.amount)));
          const ceiling = Math.ceil(maxAmt * 1.5) || 1000000;
          sliderMaxRef.current = ceiling;
          if (filters.amountMax === 1000000) {
            updateFilters({ amountMax: ceiling });
          }
        }

        if ((result.records as any[]).length === PAGE_SIZE) {
          const last = (result.records as any[]).at(-1);
          cursorRef.current = last?.paging_token ?? null;
          setHasMore(true);
        } else {
          setHasMore(false);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load transactions");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [publicKey, fetchPage, filters.amountMax, updateFilters]);

  async function loadMore() {
    if (!cursorRef.current) return;
    setLoadingMore(true);
    try {
      const result = await fetchPage(cursorRef.current);
      if (!result) return;

      const parsed = (result.records as any[])
        .map((op) => parsePaymentOp(op, publicKey!))
        .filter(Boolean) as TxRecord[];

      setRecords((prev) => [...prev, ...parsed]);

      if ((result.records as any[]).length === PAGE_SIZE) {
        const last = (result.records as any[]).at(-1);
        cursorRef.current = last?.paging_token ?? null;
        setHasMore(true);
      } else {
        cursorRef.current = null;
        setHasMore(false);
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load more transactions");
    } finally {
      setLoadingMore(false);
    }
  }

  const filtered = useMemo(
    () =>
      records.filter((r) => {
        if (filters.category !== "All" && r.category !== filters.category) return false;
        if (filters.dateFrom && r.date < filters.dateFrom) return false;
        if (filters.dateTo && r.date > filters.dateTo + "T23:59:59Z") return false;
        const amt = parseFloat(r.amount);
        if (amt < filters.amountMin || amt > filters.amountMax) return false;
        return true;
      }),
    [records, filters]
  );

  const sorted = useMemo(() => {
    const result = [...filtered];
    const direction = filters.sortDirection === "asc" ? 1 : -1;

    result.sort((a, b) => {
      let comparison = 0;

      if (filters.sortField === "date") {
        comparison = a.date.localeCompare(b.date);
      } else if (filters.sortField === "amount") {
        comparison = parseFloat(a.amount) - parseFloat(b.amount);
      } else if (filters.sortField === "type") {
        comparison = a.category.localeCompare(b.category);
      }

      return comparison * direction;
    });

    return result;
  }, [filtered, filters.sortField, filters.sortDirection]);

  function buildStatementRows(): StatementRow[] {
    return sorted.map((row) => ({
      date: formatDate(row.date),
      type: row.category.slice(0, -1),
      amount: `${row.amount} USDC`,
      status: row.status,
      reference: row.hash,
      counterparty: `${shorten(row.from)} → ${shorten(row.to)}`,
      notes: row.category,
    }));
  }

  function buildStatementPayload() {
    if (!publicKey) return;
    return {
      title: "RemitMortgage Borrower Audit Statement",
      subtitle: "Verified Horizon payment history for underwriting review.",
      metadata: createStatementMetadata({
        borrowerName: publicKey ? `Wallet ${shorten(publicKey)}` : "Unknown borrower",
        borrowerAddress: publicKey,
        walletType: "Freighter / Stellar",
      }),
      summary: [
        { label: "Verified transactions", value: String(sorted.length) },
        {
          label: "Amount range",
          value: `${filters.amountMin.toLocaleString()} - ${filters.amountMax.toLocaleString()} USDC`,
        },
        { label: "Category filter", value: filters.category },
      ],
      rows: buildStatementRows(),
    };
  }

  function handleExportCsv() {
    const payload = buildStatementPayload();
    if (!payload) return;
    downloadStatementCsv(payload, `remitmortgage-audit-statement-${Date.now()}.csv`);
  }

  function handleExportPdf() {
    const payload = buildStatementPayload();
    if (!payload) return;
    downloadStatementPdf(payload, `remitmortgage-audit-statement-${Date.now()}.pdf`);
  }

  return (
    <div className="rm-app-page min-h-screen bg-[#060913] text-slate-100 pb-20">
      <Navbar />

      <main className="max-w-7xl mx-auto px-6 pt-32 pb-20">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <span className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-cyan-500/10 text-cyan-400 text-xs font-semibold uppercase tracking-wider mb-3 border border-cyan-500/20">
              Audit & Activity Explorer
            </span>
            <h1 className="text-3xl md:text-5xl font-extrabold tracking-tight text-white mb-1">
              Transaction <span className="gradient-text">Audit Log</span>
            </h1>
            <p className="text-slate-400 text-sm">
              Verified USDC payment operations and contract interactions on Stellar Testnet.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleExportCsv}
              disabled={filtered.length === 0}
              className="btn-cta disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export CSV Log
            </button>
            <button
              onClick={handleExportPdf}
              disabled={filtered.length === 0}
              className="btn-outline-blue disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Download PDF Statement
            </button>
          </div>
        </div>

        {walletChecked && !publicKey && (
          <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-10 text-center">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <svg
                className="w-6 h-6 text-[var(--accent-primary-light)]"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3"
                />
              </svg>
            </div>
            <h2 className="text-lg font-semibold mb-2">Connect your wallet</h2>
            <p className="text-[var(--text-secondary)] text-sm">
              Connect Freighter via the navbar to view your transaction history.
            </p>
          </div>
        )}

        {publicKey && (
          <>
            <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-5 mb-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-5 gap-3">
                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <span className="text-sm font-semibold text-[var(--text-primary)]">Filter Presets:</span>
                  {presets.length === 0 ? (
                    <span className="text-xs text-[var(--text-muted)] italic">No presets saved</span>
                  ) : (
                    <div className="flex-1 sm:flex-none relative group">
                      <select
                        className="w-full sm:w-auto bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors appearance-none pr-8 cursor-pointer"
                        onChange={(e) => {
                          const id = e.target.value;
                          if (!id) return;
                          const p = presets.find((x) => x.id === id);
                          if (p) handleApplyPreset(p);
                          e.target.value = ""; // reset after apply
                        }}
                        defaultValue=""
                      >
                        <option value="" disabled>Load a preset...</option>
                        {presets.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center px-2 text-[var(--text-muted)]">
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {presets.length > 0 && (
                    <button
                      onClick={() => setShowPresetModal(true)}
                      className="text-xs px-3 py-1.5 rounded-lg border border-[var(--border-color)] hover:bg-[var(--bg-card-hover)] transition-colors"
                    >
                      Manage Presets
                    </button>
                  )}
                  <button
                    onClick={() => setShowPresetModal(true)}
                    className="text-xs px-3 py-1.5 rounded-lg bg-[var(--accent-primary)]/10 text-[var(--accent-primary-light)] hover:bg-[var(--accent-primary)]/20 transition-colors font-medium border border-[var(--accent-primary)]/30"
                  >
                    + Save Current Filters
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 pt-3 border-t border-[var(--border-color)]">
                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5 font-medium uppercase tracking-wider">
                    Category
                  </label>
                  <select
                    value={filters.category}
                    onChange={(e) => updateFilters({ category: e.target.value as TxCategory })}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                  >
                    {CATEGORY_OPTIONS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5 font-medium uppercase tracking-wider">
                    From Date
                  </label>
                  <input
                    type="date"
                    value={filters.dateFrom}
                    onChange={(e) => updateFilters({ dateFrom: e.target.value })}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5 font-medium uppercase tracking-wider">
                    To Date
                  </label>
                  <input
                    type="date"
                    value={filters.dateTo}
                    onChange={(e) => updateFilters({ dateTo: e.target.value })}
                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                  />
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5 font-medium uppercase tracking-wider">
                    Amount
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      min={0}
                      value={filters.amountMin}
                      onChange={(e) => updateFilters({ amountMin: Number(e.target.value) })}
                      placeholder="Min"
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                    />
                    <input
                      type="number"
                      min={0}
                      value={filters.amountMax}
                      onChange={(e) => updateFilters({ amountMax: Number(e.target.value) })}
                      placeholder="Max"
                      className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                    />
                  </div>
                  <div className="mt-3 text-[var(--text-muted)] text-xs">
                    Showing values between {filters.amountMin.toLocaleString()} and {filters.amountMax.toLocaleString()} USDC.
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[var(--text-muted)] mb-1.5 font-medium uppercase tracking-wider">
                    Sort by
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={filters.sortField}
                      onChange={(e) => setSortField(e.target.value as SortField)}
                      className="min-w-[120px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)] transition-colors"
                    >
                      <option value="date">Date</option>
                      <option value="amount">Amount</option>
                      <option value="type">Type</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => updateFilters({ sortDirection: filters.sortDirection === "asc" ? "desc" : "asc" })}
                      className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 py-2 text-sm text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors"
                    >
                      {filters.sortDirection === "asc" ? "Ascending" : "Descending"}
                      <span aria-hidden="true">{filters.sortDirection === "asc" ? "↑" : "↓"}</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {loading && (
              <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl p-10 text-center text-[var(--text-secondary)]">
                <div className="inline-block w-5 h-5 border-2 border-[var(--accent-primary)] border-t-transparent rounded-full animate-spin mb-3" />
                <p className="text-sm">Loading transactions…</p>
              </div>
            )}

            {error && !loading && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-5 text-red-400 text-sm">
                {error}
              </div>
            )}

            {!loading && !error && (
              <>
                {sorted.length === 0 ? (
                  <EmptyState
                    icon={<ReceiptText className="h-5 w-5" />}
                    title={
                      records.length === 0
                        ? "No transactions yet"
                        : "No transactions match the selected filters"
                    }
                    message={
                      records.length === 0
                        ? "USDC deposits, withdrawals, repayments, and disbursements will appear here once you're active."
                        : "Try widening your date range or amount filters."
                    }
                    action={
                      records.length === 0
                        ? { label: "Go to dashboard", href: "/dashboard" }
                        : undefined
                    }
                  />
                ) : (
                  <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-[var(--border-color)] text-[var(--text-muted)] text-xs uppercase tracking-wider">
                            <th className="px-5 py-3 text-left font-medium">Date</th>
                            <th className="px-5 py-3 text-left font-medium">Type</th>
                            <th className="px-5 py-3 text-right font-medium">Amount</th>
                            <th className="px-5 py-3 text-left font-medium">Status</th>
                            <th className="px-5 py-3 text-left font-medium">Transaction</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sorted.map((tx) => (
                            <tr
                              key={tx.id}
                              className="border-b border-[var(--border-color)]/40 last:border-0 hover:bg-[var(--bg-card-hover)] transition-colors"
                            >
                              <td className="px-5 py-4 text-[var(--text-secondary)] whitespace-nowrap">
                                {formatDate(tx.date)}
                              </td>

                              <td className="px-5 py-4">
                                <span
                                  className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ${CATEGORY_STYLES[tx.category]}`}
                                >
                                  {tx.category.slice(0, -1)}
                                </span>
                              </td>

                              <td className="px-5 py-4 text-right font-medium tabular-nums">
                                <span
                                  className={
                                    tx.from === publicKey
                                      ? "text-[var(--text-primary)]"
                                      : "text-emerald-400"
                                  }
                                >
                                  {tx.from === publicKey ? "−" : "+"}
                                  {tx.amount} USDC
                                </span>
                              </td>

                              <td className="px-5 py-4">
                                <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
                                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                                  {tx.status}
                                </span>
                              </td>

                              <td className="px-5 py-4">
                                <a
                                  href={`${STELLARCHAIN_BASE}${tx.hash}`}
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

                    {hasMore && (
                      <div className="px-5 py-4 border-t border-[var(--border-color)]">
                        <button
                          onClick={loadMore}
                          disabled={loadingMore}
                          className="w-full py-2.5 rounded-lg border border-[var(--border-color)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-card-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          {loadingMore ? "Loading…" : "Load More"}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                <p className="mt-3 text-xs text-[var(--text-muted)]">
                  Showing {sorted.length} of {records.length} loaded transactions
                </p>
              </>
            )}
          </>
        )}

        {/* Preset Management Modal */}
        {showPresetModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <div className="bg-[var(--bg-card)] border border-[var(--border-color)] rounded-xl w-full max-w-md shadow-2xl p-6">
              <div className="flex items-center justify-between mb-5">
                <h3 className="text-lg font-bold text-white">Save Filter Preset</h3>
                <button
                  onClick={() => {
                    setShowPresetModal(false);
                    setEditingPresetId(null);
                  }}
                  className="text-[var(--text-muted)] hover:text-white transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
              </div>

              <div className="mb-6">
                <label className="block text-xs text-[var(--text-muted)] mb-1.5 font-medium uppercase tracking-wider">
                  Preset Name
                </label>
                <input
                  type="text"
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  placeholder="e.g., Large Withdrawals, Q3 Deposits..."
                  className="w-full bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-[var(--accent-primary)] transition-colors"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSavePreset();
                  }}
                />
                <button
                  onClick={handleSavePreset}
                  disabled={!newPresetName.trim()}
                  className="mt-3 w-full py-2 bg-[var(--accent-primary)] text-white font-medium rounded-lg hover:bg-[var(--accent-primary-light)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save Preset
                </button>
              </div>

              {presets.length > 0 && (
                <div className="border-t border-[var(--border-color)] pt-5">
                  <h4 className="text-xs text-[var(--text-muted)] mb-3 font-medium uppercase tracking-wider">
                    Existing Presets
                  </h4>
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {presets.map((p) => (
                      <div key={p.id} className="flex items-center justify-between bg-[var(--bg-secondary)] p-2.5 rounded-lg border border-[var(--border-color)] group">
                        {editingPresetId === p.id ? (
                          <div className="flex flex-1 items-center gap-2 mr-2">
                            <input
                              type="text"
                              value={editingPresetName}
                              onChange={(e) => setEditingPresetName(e.target.value)}
                              className="flex-1 bg-[var(--bg-card)] border border-[var(--accent-primary)] rounded px-2 py-1 text-xs text-white outline-none"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") handleRenamePreset(p.id);
                                if (e.key === "Escape") setEditingPresetId(null);
                              }}
                            />
                            <button
                              onClick={() => handleRenamePreset(p.id)}
                              className="text-xs text-emerald-400 hover:text-emerald-300 font-medium"
                            >
                              Save
                            </button>
                          </div>
                        ) : (
                          <span className="text-sm text-white truncate max-w-[200px]" title={p.name}>
                            {p.name}
                          </span>
                        )}

                        {editingPresetId !== p.id && (
                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => {
                                setEditingPresetId(p.id);
                                setEditingPresetName(p.name);
                              }}
                              className="p-1.5 text-[var(--text-muted)] hover:text-white bg-[var(--bg-card-hover)] rounded-md transition-colors"
                              title="Rename"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                            </button>
                            <button
                              onClick={() => handleDeletePreset(p.id)}
                              className="p-1.5 text-red-400/70 hover:text-red-400 bg-red-400/10 hover:bg-red-400/20 rounded-md transition-colors"
                              title="Delete"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
