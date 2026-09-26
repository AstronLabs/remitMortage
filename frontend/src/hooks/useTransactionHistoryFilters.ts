"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export type TxCategory = "All" | "Deposits" | "Withdrawals" | "Repayments" | "Disbursements";
export type SortField = "date" | "amount" | "type";
export type SortDirection = "asc" | "desc";

export interface TransactionHistoryFilters {
  category: TxCategory;
  dateFrom: string;
  dateTo: string;
  amountMin: number;
  amountMax: number;
  sortField: SortField;
  sortDirection: SortDirection;
}

const DEFAULT_FILTERS: TransactionHistoryFilters = {
  category: "All",
  dateFrom: "",
  dateTo: "",
  amountMin: 0,
  amountMax: 1000000,
  sortField: "date",
  sortDirection: "desc",
};

function normalizeCategory(value: string | null): TxCategory {
  if (!value) return "All";
  switch (value.toLowerCase()) {
    case "deposits":
    case "deposit":
      return "Deposits";
    case "withdrawals":
    case "withdrawal":
      return "Withdrawals";
    case "repayments":
    case "repayment":
      return "Repayments";
    case "disbursements":
    case "disbursement":
      return "Disbursements";
    default:
      return "All";
  }
}

function normalizeNumber(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeSortField(value: string | null): SortField {
  switch (value?.toLowerCase()) {
    case "amount":
      return "amount";
    case "type":
      return "type";
    default:
      return "date";
  }
}

function normalizeSortDirection(value: string | null): SortDirection {
  return value?.toLowerCase() === "asc" ? "asc" : "desc";
}

function buildSearchParams(filters: TransactionHistoryFilters) {
  const params = new URLSearchParams();

  if (filters.category !== "All") {
    params.set("type", filters.category.toLowerCase());
  }
  if (filters.dateFrom) {
    params.set("dateFrom", filters.dateFrom);
  }
  if (filters.dateTo) {
    params.set("dateTo", filters.dateTo);
  }
  if (filters.amountMin > 0) {
    params.set("amountMin", String(filters.amountMin));
  }
  if (filters.amountMax !== DEFAULT_FILTERS.amountMax) {
    params.set("amountMax", String(filters.amountMax));
  }
  if (filters.sortField !== DEFAULT_FILTERS.sortField) {
    params.set("sort", filters.sortField);
  }
  if (filters.sortDirection !== DEFAULT_FILTERS.sortDirection) {
    params.set("direction", filters.sortDirection);
  }

  return params;
}

function parseFilters(params: URLSearchParams): TransactionHistoryFilters {
  return {
    category: normalizeCategory(params.get("type")),
    dateFrom: params.get("dateFrom") ?? "",
    dateTo: params.get("dateTo") ?? "",
    amountMin: normalizeNumber(params.get("amountMin"), DEFAULT_FILTERS.amountMin),
    amountMax: normalizeNumber(params.get("amountMax"), DEFAULT_FILTERS.amountMax),
    sortField: normalizeSortField(params.get("sort")),
    sortDirection: normalizeSortDirection(params.get("direction")),
  };
}

export default function useTransactionHistoryFilters(initialAmountMax = DEFAULT_FILTERS.amountMax) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<TransactionHistoryFilters>(DEFAULT_FILTERS);
  const isReadyRef = useRef(false);

  useEffect(() => {
    if (!searchParams) return;
    const parsed = parseFilters(searchParams);
    const normalized = {
      ...DEFAULT_FILTERS,
      ...parsed,
      amountMax: Math.max(parsed.amountMax, initialAmountMax),
    };
    setFilters(normalized);
    isReadyRef.current = true;
  }, [searchParams, initialAmountMax]);

  useEffect(() => {
    if (!isReadyRef.current) return;
    const params = buildSearchParams(filters);
    const query = params.toString();
    const url = `${window.location.pathname}${query ? `?${query}` : ""}`;
    router.replace(url, { scroll: false });
  }, [filters, router]);

  const updateFilters = useCallback((patch: Partial<TransactionHistoryFilters>) => {
    setFilters((prev) => ({ ...prev, ...patch }));
  }, []);

  const setSortField = useCallback((field: SortField) => {
    setFilters((prev) => ({
      ...prev,
      sortField: field,
      sortDirection: prev.sortField === field ? (prev.sortDirection === "asc" ? "desc" : "asc") : "desc",
    }));
  }, []);

  return { filters, updateFilters, setSortField };
}
