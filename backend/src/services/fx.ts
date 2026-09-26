// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { getCacheValue, setCacheValue } from "./redis.js";
import logger from "../utils/logger.js";

// Hardcoded fallbacks in case the API is down
const FALLBACK_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  NGN: 1500.0, // Example fallback for Nigerian Naira
  KES: 135.0,  // Example fallback for Kenyan Shilling
};

const CACHE_KEY = "fx_rates_usd_base";
const CACHE_TTL_SECONDS = 3600; // 1 hour

/**
 * How old a cached rate can be before it is considered stale.
 * A stale rate is still served (the fallback for a genuinely unavailable feed)
 * but is flagged in API responses so callers can surface a warning.
 * Defaults to 30 minutes; override via FX_STALENESS_THRESHOLD_SECONDS env var.
 */
const STALENESS_THRESHOLD_SECONDS = (() => {
  const v = parseInt(process.env.FX_STALENESS_THRESHOLD_SECONDS ?? "1800", 10);
  return Number.isFinite(v) && v > 0 ? v : 1800;
})();

/** Shape stored in Redis — includes a timestamp alongside the rates. */
interface CachedRatesEntry {
  rates: Record<string, number>;
  fetchedAt: string; // ISO-8601 timestamp
}

export interface RatesWithMeta {
  rates: Record<string, number>;
  /** When this batch of rates was fetched from the upstream source. */
  fetchedAt: Date | null;
  /** True when the rates are older than {@link STALENESS_THRESHOLD_SECONDS}. */
  isStale: boolean;
  /** How many whole minutes ago the rates were last fetched, or null when unknown. */
  ageMinutes: number | null;
}

/**
 * Returns exchange rates together with freshness metadata.
 *
 * The staleness check is independent of the cache-miss / fetch-failure path:
 * a rate can be within the TTL window (cache hit) but still stale if the
 * upstream refresh cycle is running behind schedule.
 */
export async function getExchangeRatesWithMeta(): Promise<RatesWithMeta> {
  // ── Try cache first ────────────────────────────────────────────────────────
  try {
    const cached = await getCacheValue<CachedRatesEntry>(CACHE_KEY);
    if (cached?.rates) {
      const fetchedAt = cached.fetchedAt ? new Date(cached.fetchedAt) : null;
      const ageMs = fetchedAt ? Date.now() - fetchedAt.getTime() : null;
      const ageMinutes = ageMs !== null ? Math.floor(ageMs / 60_000) : null;
      const isStale = ageMs !== null && ageMs / 1000 > STALENESS_THRESHOLD_SECONDS;
      return { rates: cached.rates, fetchedAt, isStale, ageMinutes };
    }
  } catch (error) {
    logger.warn("Failed to read FX rates from cache", { error });
  }

  // ── Fetch fresh rates ──────────────────────────────────────────────────────
  try {
    // In production, replace with a real exchange-rate API call, e.g.:
    // const res = await fetch(`https://openexchangerates.org/api/latest.json?app_id=${process.env.FX_API_KEY}`);
    // const data = await res.json();
    // const rates = data.rates;
    const rates = { ...FALLBACK_RATES };
    const fetchedAt = new Date();

    try {
      const entry: CachedRatesEntry = { rates, fetchedAt: fetchedAt.toISOString() };
      await setCacheValue(CACHE_KEY, entry, CACHE_TTL_SECONDS);
    } catch (cacheError) {
      logger.warn("Failed to cache FX rates", { cacheError });
    }

    return { rates, fetchedAt, isStale: false, ageMinutes: 0 };
  } catch (error) {
    logger.error("Failed to fetch FX rates from external API, using fallbacks", { error });
    return { rates: FALLBACK_RATES, fetchedAt: null, isStale: false, ageMinutes: null };
  }
}

/**
 * Fetches the latest exchange rates (Base: USD).
 * Checks Redis cache first, then falls back to an external API (simulated here),
 * and finally falls back to hardcoded rates.
 *
 * For API responses that need staleness metadata, use {@link getExchangeRatesWithMeta}.
 */
export async function getExchangeRates(): Promise<Record<string, number>> {
  const { rates } = await getExchangeRatesWithMeta();
  return rates;
}

/**
 * Converts an amount from USD (which is 1:1 with USDC) to a target currency.
 * @param amountUsd The amount in USD
 * @param targetCurrency The currency code (e.g. "NGN")
 * @returns The converted amount, or the original amount if the currency is not found.
 */
export async function convertUsdTo(amountUsd: number, targetCurrency: string): Promise<number> {
  const currency = targetCurrency.toUpperCase();
  if (currency === "USD" || currency === "USDC") return amountUsd;

  const rates = await getExchangeRates();
  const rate = rates[currency];

  if (!rate) {
    logger.warn(`Exchange rate for ${currency} not found. Falling back to USD.`);
    return amountUsd;
  }

  return amountUsd * rate;
}
