"use client";
// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState, useCallback } from "react";

export interface RateBenchmarkData {
  protocolAvgRateBps: number;
  protocolMedianRateBps: number;
  seniorApyBps: number;
  juniorApyBps: number;
  totalLoans: number;
  hasSufficientData: boolean;
  riskTier: string;
  liquidity: string | null;
  lastUpdated: string;
}

export function useRateBenchmark(riskTier?: string) {
  const [data, setData] = useState<RateBenchmarkData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (riskTier) params.set("riskTier", riskTier);
      const res = await fetch(`/api/analytics/rate-benchmark?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to load rate benchmark data");
      const json = await res.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load benchmark");
    } finally {
      setLoading(false);
    }
  }, [riskTier]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refetch: fetchData };
}
