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
 * Fetches the latest exchange rates (Base: USD).
 * Checks Redis cache first, then falls back to an external API (simulated here),
 * and finally falls back to hardcoded rates.
 */
export async function getExchangeRates(): Promise<Record<string, number>> {
  try {
    const cached = await getCacheValue<Record<string, number>>(CACHE_KEY);
    if (cached) {
      return cached;
    }
  } catch (error) {
    logger.warn("Failed to read FX rates from cache", { error });
  }

  try {
    // In a real production app, you would fetch from an API like OpenExchangeRates or Fixer.
    // e.g. await fetch(`https://openexchangerates.org/api/latest.json?app_id=${process.env.FX_API_KEY}`)
    
    // For this implementation, we simulate fetching fresh rates by using the fallbacks,
    // potentially with slight randomized jitters if we wanted, but static is safer for tests.
    const rates = { ...FALLBACK_RATES };

    // Cache the result
    try {
      await setCacheValue(CACHE_KEY, rates, CACHE_TTL_SECONDS);
    } catch (cacheError) {
      logger.warn("Failed to cache FX rates", { cacheError });
    }

    return rates;
  } catch (error) {
    logger.error("Failed to fetch FX rates from external API, using fallbacks", { error });
    return FALLBACK_RATES;
  }
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
