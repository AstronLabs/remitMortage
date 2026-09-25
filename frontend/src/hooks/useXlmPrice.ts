// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { useState, useEffect } from "react";

let cachedPrice: number | null = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 60_000;

/**
 * Custom hook to fetch the latest XLM price in USD from CoinGecko.
 * Uses an in-memory cache to prevent rate limiting issues during re-renders.
 */
export function useXlmPrice() {
  const [price, setPrice] = useState<number | null>(cachedPrice);

  useEffect(() => {
    let active = true;

    async function fetchPrice() {
      if (cachedPrice && Date.now() - lastFetchTime < CACHE_DURATION_MS) {
        if (active) setPrice(cachedPrice);
        return;
      }

      try {
        const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd");
        if (!res.ok) throw new Error("Network response was not ok");
        const data = await res.json();
        
        if (data?.stellar?.usd) {
          cachedPrice = data.stellar.usd;
          lastFetchTime = Date.now();
          if (active) setPrice(cachedPrice);
        }
      } catch (err) {
        console.error("Failed to fetch XLM price", err);
      }
    }

    fetchPrice();

    return () => {
      active = false;
    };
  }, []);

  return price;
}
