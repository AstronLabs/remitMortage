// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export interface AuditLogEntry {
  id: string;
  action: string;
  actorAddress: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogPagination {
  limit: number;
  cursor: string | null;
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface AuditLogResponse {
  data: AuditLogEntry[];
  pagination: AuditLogPagination;
}

export interface AuditLogFilters {
  action?: string;
  actorAddress?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Fetch audit logs from the backend API with cursor-based pagination.
 */
export async function fetchAuditLogs(
  filters: AuditLogFilters = {},
  token?: string
): Promise<AuditLogResponse> {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.actorAddress) params.set("actorAddress", filters.actorAddress);
  if (filters.limit) params.set("limit", String(filters.limit));
  if (filters.cursor) params.set("cursor", filters.cursor);

  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/api/audit-logs?${params.toString()}`, {
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch audit logs: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Client-side full-text search across audit log entries.
 * Filters by matching the search term against action, actorAddress,
 * metadata description fields, and record IDs.
 */
export function filterAuditLogs(
  logs: AuditLogEntry[],
  search: string
): AuditLogEntry[] {
  if (!search.trim()) return logs;

  const term = search.toLowerCase();
  return logs.filter((log) => {
    if (log.action.toLowerCase().includes(term)) return true;
    if (log.actorAddress?.toLowerCase().includes(term)) return true;
    if (log.ipAddress?.toLowerCase().includes(term)) return true;

    // Search metadata values (descriptions, record IDs, etc.)
    const metaStr = JSON.stringify(log.metadata).toLowerCase();
    if (metaStr.includes(term)) return true;

    return false;
  });
}

/**
 * Filter audit logs by date range (client-side).
 */
export function filterByDateRange(
  logs: AuditLogEntry[],
  from?: Date,
  to?: Date
): AuditLogEntry[] {
  // `to` is a date picker value (e.g. "2025-01-16", parsed as UTC midnight);
  // treat it as inclusive of the entire UTC day rather than cutting off at
  // midnight.
  const inclusiveTo = to
    ? new Date(
        Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 23, 59, 59, 999)
      )
    : undefined;

  return logs.filter((log) => {
    const date = new Date(log.createdAt);
    if (from && date < from) return false;
    if (inclusiveTo && date > inclusiveTo) return false;
    return true;
  });
}

/**
 * Convert audit log entries to CSV format.
 */
export function exportToCsv(logs: AuditLogEntry[]): string {
  const headers = ["ID", "Action", "Actor Address", "IP Address", "Metadata", "Created At"];
  const rows = logs.map((log) => [
    log.id,
    log.action,
    log.actorAddress ?? "",
    log.ipAddress ?? "",
    JSON.stringify(log.metadata),
    log.createdAt,
  ]);

  const escapeCsv = (val: string) => {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
      return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
  };

  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsv).join(","));
  }
  return lines.join("\n");
}

/**
 * Trigger a browser download of a CSV file.
 */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
