"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import React, { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Search, Download, ChevronLeft, ChevronRight, History, Filter } from "lucide-react";
import {
  AuditLogEntry,
  AuditLogFilters,
  fetchAuditLogs,
  filterAuditLogs,
  filterByDateRange,
  exportToCsv,
  downloadCsv,
} from "../lib/auditApi";
import { EmptyState } from "./EmptyState";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTION_OPTIONS = [
  "deposit",
  "withdraw",
  "release",
  "top_up",
  "loan_approved",
  "loan_rejected",
  "milestone_approved",
  "kyc_verified",
  "admin_login",
  "pause",
  "unpause",
];

const PAGE_SIZE = 20;

// ── Component ────────────────────────────────────────────────────────────────

export default function AuditLogViewer({ adminToken }: { adminToken?: string }) {
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [actionFilter, setActionFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Pagination
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [pageHistory, setPageHistory] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);

  // ── Data Fetching ────────────────────────────────────────────────────────

  const loadLogs = useCallback(
    async (fetchCursor?: string, append = false) => {
      setLoading(true);
      setError(null);
      try {
        const filters: AuditLogFilters = {
          action: actionFilter || undefined,
          actorAddress: actorFilter || undefined,
          limit: PAGE_SIZE,
          cursor: fetchCursor,
        };

        const response = await fetchAuditLogs(filters, adminToken);

        setLogs((prev) => (append ? [...prev, ...response.data] : response.data));
        setHasNextPage(response.pagination.hasNextPage);
        setCursor(response.pagination.nextCursor ?? undefined);
        setTotalCount(append ? totalCount + response.data.length : response.data.length);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load audit logs");
        toast.error("Failed to load audit logs.");
      } finally {
        setLoading(false);
      }
    },
    [actionFilter, actorFilter, adminToken, totalCount]
  );

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  // ── Client-Side Filtering ────────────────────────────────────────────────

  const displayLogs = useMemo(() => {
    let filtered = filterAuditLogs(logs, searchTerm);
    if (dateFrom || dateTo) {
      filtered = filterByDateRange(
        filtered,
        dateFrom ? new Date(dateFrom) : undefined,
        dateTo ? new Date(dateTo + "T23:59:59") : undefined
      );
    }
    return filtered;
  }, [logs, searchTerm, dateFrom, dateTo]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleSearchChange(value: string) {
    setSearchTerm(value);
  }

  function handleApplyFilters() {
    setPageHistory([]);
    loadLogs();
  }

  function handleNextPage() {
    if (cursor) {
      setPageHistory((prev) => [...prev, cursor]);
      loadLogs(cursor, true);
    }
  }

  function handlePrevPage() {
    if (pageHistory.length > 0) {
      const prevCursor = pageHistory[pageHistory.length - 1];
      setPageHistory((prev) => prev.slice(0, -1));
      loadLogs(prevCursor);
    }
  }

  function handleExportCsv() {
    const csv = exportToCsv(displayLogs);
    const timestamp = new Date().toISOString().slice(0, 10);
    downloadCsv(csv, `audit-log-export-${timestamp}.csv`);
    toast.success(`Exported ${displayLogs.length} audit entries.`);
  }

  function handleResetFilters() {
    setActionFilter("");
    setActorFilter("");
    setSearchTerm("");
    setDateFrom("");
    setDateTo("");
    setPageHistory([]);
  }

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Filters Bar */}
      <div className="p-4 bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)]">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="h-4 w-4 text-[var(--text-muted)]" />
          <h3 className="text-sm font-semibold">Filters</h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Search */}
          <div className="relative lg:col-span-2">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="Search actions, addresses, record IDs..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            />
          </div>

          {/* Action Filter */}
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
          >
            <option value="">All Actions</option>
            {ACTION_OPTIONS.map((action) => (
              <option key={action} value={action}>
                {action.replace(/_/g, " ")}
              </option>
            ))}
          </select>

          {/* Actor Filter */}
          <input
            type="text"
            placeholder="Actor address..."
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="px-3 py-2 text-sm rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
          />
        </div>

        {/* Date Range */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">From Date</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">To Date</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full px-3 py-2 text-sm rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
            />
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 mt-3">
          <button
            onClick={handleApplyFilters}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--accent-primary)] text-white hover:opacity-90 transition-colors disabled:opacity-50"
          >
            Apply Filters
          </button>
          <button
            onClick={handleResetFilters}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] transition-colors"
          >
            Reset
          </button>
          <button
            onClick={handleExportCsv}
            disabled={displayLogs.length === 0}
            className="ml-auto px-4 py-2 text-sm font-medium rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {/* Results Summary */}
      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
        <span>
          Showing {displayLogs.length} {displayLogs.length === 1 ? "entry" : "entries"}
          {searchTerm && ` (filtered from ${logs.length})`}
        </span>
        {hasNextPage && (
          <button
            onClick={handleNextPage}
            disabled={loading}
            className="text-[var(--accent-primary-light)] hover:underline"
          >
            Load more...
          </button>
        )}
      </div>

      {/* Error State */}
      {error && (
        <div className="p-4 rounded-lg border border-red-500/40 bg-red-500/10 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Loading State */}
      {loading && logs.length === 0 && (
        <div className="p-8 text-center text-sm text-[var(--text-muted)] bg-[var(--bg-card)] rounded-lg border border-[var(--border-color)] animate-pulse">
          Loading audit logs...
        </div>
      )}

      {/* Empty State */}
      {!loading && displayLogs.length === 0 && !error && (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title="No audit entries found"
          message="Adjust your filters or check back later for new activity."
        />
      )}

      {/* Audit Log Table */}
      {displayLogs.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-[var(--border-color)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border-color)] bg-[var(--bg-card)]">
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Timestamp</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Action</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Actor</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">Details</th>
                <th className="px-4 py-3 text-left font-medium text-[var(--text-muted)]">IP</th>
              </tr>
            </thead>
            <tbody>
              {displayLogs.map((log) => (
                <tr
                  key={log.id}
                  className="border-b border-[var(--border-color)] last:border-0 hover:bg-[var(--bg-card)]/50 transition-colors"
                >
                  <td className="px-4 py-3 text-xs font-mono whitespace-nowrap">
                    {formatTimestamp(log.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    <ActionBadge action={log.action} />
                  </td>
                  <td className="px-4 py-3 text-xs font-mono">
                    {log.actorAddress ? shortenAddress(log.actorAddress) : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-secondary)] max-w-xs truncate">
                    {formatMetadata(log.metadata)}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--text-muted)]">
                    {log.ipAddress ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {displayLogs.length > 0 && (
        <div className="flex items-center justify-between">
          <button
            onClick={handlePrevPage}
            disabled={pageHistory.length === 0 || loading}
            className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] transition-colors disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </button>
          <button
            onClick={handleNextPage}
            disabled={!hasNextPage || loading}
            className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-lg border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-card)] transition-colors disabled:opacity-40"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Sub-Components ───────────────────────────────────────────────────────────

function ActionBadge({ action }: { action: string }) {
  const colorMap: Record<string, string> = {
    deposit: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    withdraw: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    release: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    top_up: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    loan_approved: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    loan_rejected: "bg-red-500/15 text-red-400 border-red-500/30",
    milestone_approved: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    kyc_verified: "bg-purple-500/15 text-purple-400 border-purple-500/30",
    admin_login: "bg-slate-500/15 text-slate-400 border-slate-500/30",
    pause: "bg-red-500/15 text-red-400 border-red-500/30",
    unpause: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  };

  const colorClass = colorMap[action] ?? "bg-[var(--bg-card)] text-[var(--text-secondary)] border-[var(--border-color)]";

  return (
    <span className={`inline-flex px-2 py-0.5 text-xs font-medium rounded border ${colorClass}`}>
      {action.replace(/_/g, " ")}
    </span>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatMetadata(metadata: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) return "—";
  // Show a concise summary of metadata
  const entries = Object.entries(metadata);
  if (entries.length <= 2) {
    return entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  }
  return `${entries[0][0]}: ${String(entries[0][1])}, +${entries.length - 1} fields`;
}
