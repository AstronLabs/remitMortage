"use client";

import { useEffect, useState, useCallback } from "react";
import type { PortfolioSegment } from "../lib/portfolioBreakdown";

export interface PortfolioBreakdownData {
  wallet: string;
  totalDeposited: number;
  segments: PortfolioSegment[];
}

export function usePortfolioBreakdown(wallet: string | null, totalDeposited?: number) {
  const [data, setData] = useState<PortfolioBreakdownData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    if (!wallet) {
      setData(null);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ wallet });
      if (totalDeposited && totalDeposited > 0) {
        params.set("totalDeposited", String(totalDeposited));
      }
      const res = await fetch(`/api/investor/portfolio-breakdown?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load portfolio breakdown");
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load portfolio breakdown");
    } finally {
      setLoading(false);
    }
  }, [wallet, totalDeposited]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
