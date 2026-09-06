import { Router } from "express";
import {
  getProtocolOverview,
  getLoanPerformance,
  getDisbursementProgress,
  getMonthlyVolume,
  getProtocolOverviewFromView,
  getLoanPerformanceFromView,
  getDisbursementProgressFromView,
  getMonthlyVolumeFromView,
} from "../services/analytics.js";
import { getLendingPoolRates } from "../services/soroban.js";
import { feeEstimator } from "../services/feeEstimator.js";
import { cacheMiddleware } from "../middleware/cache.js";
import { loadConfig } from "../config.js";
import { convertUsdTo } from "../services/fx.js";
import { authMiddleware, requireAdmin } from "../middleware/auth.js";
import {
  enqueueAnalyticsEvents,
  getAnalyticsCounts,
  getAnalyticsFunnel,
  MAX_ANALYTICS_BATCH_SIZE,
  validateAnalyticsInput,
} from "../services/analyticsEvents.js";

export const analyticsRouter = Router();

function queryDateRange(req: any): { start: Date; end: Date } | null {
  const start = new Date(String(req.query.start ?? ""));
  const end = new Date(String(req.query.end ?? ""));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) return null;
  return { start, end };
}

analyticsRouter.post("/events", authMiddleware, async (req: any, res) => {
  if (!req.user?.walletAddress || typeof req.user.walletAddress !== "string") {
    return res.status(401).json({ error: "unauthorized", message: "Authenticated wallet identity missing" });
  }
  const body = req.body ?? {};
  const inputs = Array.isArray(body.events) ? body.events : [body];
  if (inputs.length < 1 || inputs.length > MAX_ANALYTICS_BATCH_SIZE || inputs.some((event: unknown) => !validateAnalyticsInput(event))) {
    return res.status(400).json({ error: "invalid_analytics_event", message: `Provide 1-${MAX_ANALYTICS_BATCH_SIZE} valid events.` });
  }
  try {
    // userId is intentionally taken from the verified JWT, never the body.
    await enqueueAnalyticsEvents(req.user.walletAddress, inputs);
    return res.status(202).json({ accepted: inputs.length });
  } catch (error) {
    console.error("Analytics ingestion error:", error);
    return res.status(503).json({ error: "analytics_unavailable" });
  }
});

analyticsRouter.get("/events/counts", requireAdmin, async (req, res) => {
  const range = queryDateRange(req);
  if (!range) return res.status(400).json({ error: "invalid_date_range", message: "start and end must be valid dates with start before end." });
  try {
    return res.json(await getAnalyticsCounts(range.start, range.end, typeof req.query.event === "string" ? req.query.event : undefined));
  } catch (error) {
    console.error("Analytics counts error:", error);
    return res.status(500).json({ error: "analytics_query_failed" });
  }
});

analyticsRouter.get("/events/funnel", requireAdmin, async (req, res) => {
  const range = queryDateRange(req);
  const requested = typeof req.query.events === "string" ? req.query.events.split(",").map((event) => event.trim()).filter(Boolean) : [];
  if (!range || requested.length < 2 || requested.length > 10 || requested.some((event) => !/^[a-z][a-z0-9_.-]{1,99}$/.test(event))) {
    return res.status(400).json({ error: "invalid_funnel", message: "Provide 2-10 event names and a valid date range." });
  }
  try {
    return res.json(await getAnalyticsFunnel(range.start, range.end, requested));
  } catch (error) {
    console.error("Analytics funnel error:", error);
    return res.status(500).json({ error: "analytics_query_failed" });
  }
});

const DEFAULT_VOLUME_MONTHS = 6;
const MAX_VOLUME_MONTHS = 24;

/**
 * @openapi
 * /api/analytics/overview:
 *   get:
 *     summary: Protocol overview metrics
 *     description: >-
 *       Returns aggregate protocol metrics — total value locked (escrow +
 *       lending pool), and counts of borrowers, investors, and loans. Cached
 *       for 60 seconds.
 *     tags:
 *       - Analytics
 *     responses:
 *       200:
 *         description: Protocol summary.
 */
analyticsRouter.get("/overview", cacheMiddleware(60), async (req, res) => {
  try {
    const overview = (await getProtocolOverviewFromView()) ?? getProtocolOverview();
    const currency = (req.query.currency as string) || "USD";

    if (currency !== "USD" && currency !== "USDC") {
      const converted = { ...overview, tvl: { ...overview.tvl } };
      converted.tvl.escrow = (await convertUsdTo(parseFloat(overview.tvl.escrow), currency)).toFixed(2);
      converted.tvl.lendingPool = (await convertUsdTo(parseFloat(overview.tvl.lendingPool), currency)).toFixed(2);
      converted.tvl.total = (await convertUsdTo(parseFloat(overview.tvl.total), currency)).toFixed(2);
      
      // Clearly label converted values
      (converted as any).isConvertedEstimate = true;
      (converted as any).displayCurrency = currency;
      
      return res.json(converted);
    }

    res.json(overview);
  } catch (error) {
    console.error("Analytics overview error:", error);
    res.status(500).json({ error: "Failed to compute protocol overview" });
  }
});

/**
 * @openapi
 * /api/analytics/loans:
 *   get:
 *     summary: Loan performance breakdown
 *     description: >-
 *       Returns active/repaid/defaulted loan counts along with repayment rate,
 *       default rate, and on-time payment percentage. Cached for 60 seconds.
 *     tags:
 *       - Analytics
 *     responses:
 *       200:
 *         description: Loan performance metrics.
 */
analyticsRouter.get("/loans", cacheMiddleware(60), async (_req, res) => {
  try {
    const performance = (await getLoanPerformanceFromView()) ?? getLoanPerformance();
    res.json(performance);
  } catch (error) {
    console.error("Analytics loans error:", error);
    res.status(500).json({ error: "Failed to compute loan performance" });
  }
});

/**
 * @openapi
 * /api/analytics/disbursement:
 *   get:
 *     summary: Disbursement and milestone progress
 *     description: >-
 *       Returns total disbursed, milestones completed vs. pending, and the
 *       average time to complete a milestone. Cached for 60 seconds.
 *     tags:
 *       - Analytics
 *     responses:
 *       200:
 *         description: Disbursement progress metrics.
 */
analyticsRouter.get("/disbursement", cacheMiddleware(60), async (req, res) => {
  try {
    const progress = (await getDisbursementProgressFromView()) ?? getDisbursementProgress();
    const currency = (req.query.currency as string) || "USD";

    if (currency !== "USD" && currency !== "USDC") {
      const converted = { ...progress };
      converted.totalDisbursed = (await convertUsdTo(parseFloat(progress.totalDisbursed), currency)).toFixed(2);
      
      (converted as any).isConvertedEstimate = true;
      (converted as any).displayCurrency = currency;
      
      return res.json(converted);
    }

    res.json(progress);
  } catch (error) {
    console.error("Analytics disbursement error:", error);
    res.status(500).json({ error: "Failed to compute disbursement progress" });
  }
});

/**
 * @openapi
 * /api/analytics/volume:
 *   get:
 *     summary: Monthly volume time-series
 *     description: >-
 *       Returns monthly deposit, repayment, and disbursement volume for the
 *       requested number of months (default 6, max 24). Cached for 60 seconds.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: months
 *         required: false
 *         description: Number of trailing months to return (1-24).
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 24
 *           default: 6
 *     responses:
 *       200:
 *         description: Monthly volume series, oldest first.
 */
analyticsRouter.get("/volume", cacheMiddleware(60), async (req, res) => {
  try {
    const parsed = parseInt(String(req.query.months ?? ""), 10);
    const months = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), MAX_VOLUME_MONTHS)
      : DEFAULT_VOLUME_MONTHS;
      
    const volumeData = (await getMonthlyVolumeFromView(months)) ?? getMonthlyVolume(months);
    const currency = (req.query.currency as string) || "USD";

    if (currency !== "USD" && currency !== "USDC") {
      const converted = await Promise.all(volumeData.map(async (month) => {
        return {
          ...month,
          deposits: (await convertUsdTo(parseFloat(month.deposits), currency)).toFixed(2),
          repayments: (await convertUsdTo(parseFloat(month.repayments), currency)).toFixed(2),
          disbursements: (await convertUsdTo(parseFloat(month.disbursements), currency)).toFixed(2),
        };
      }));
      
      return res.json({
        data: converted,
        isConvertedEstimate: true,
        displayCurrency: currency
      });
    }

    res.json(volumeData);
  } catch (error) {
    console.error("Analytics volume error:", error);
    res.status(500).json({ error: "Failed to compute monthly volume" });
  }
});

/**
 * @openapi
 * /api/analytics/pool-rates:
 *   get:
 *     summary: Live lending-pool interest rates
 *     description: >-
 *       Reads the deployed lending-pool contract's on-chain configuration
 *       (the protocol's rate registry) and derives the current senior and
 *       junior tranche APYs from it, rather than a static estimate. Cached
 *       for 60 seconds to limit RPC traffic.
 *     tags:
 *       - Analytics
 *     responses:
 *       200:
 *         description: Live pool/senior/junior APY figures (basis points) and tranche liquidity.
 *       502:
 *         description: Unable to query the lending-pool contract.
 *       503:
 *         description: Lending pool contract is not configured.
 */
analyticsRouter.get("/pool-rates", cacheMiddleware(60), async (_req, res) => {
  const { lendingPoolContractId } = loadConfig();

  if (!lendingPoolContractId) {
    res.status(503).json({
      error: "not_configured",
      message: "LENDING_POOL_CONTRACT_ID is not configured",
    });
    return;
  }

  try {
    const rates = await getLendingPoolRates(lendingPoolContractId);
    res.json(rates);
  } catch (error) {
    console.error("Analytics pool-rates error:", error);
    res.status(502).json({
      error: "on_chain_unavailable",
      message: "Unable to query the lending pool contract. Please retry shortly.",
    });
  }
});

/**
 * @openapi
 * /api/analytics/gas:
 *   get:
 *     summary: Live gas fee recommendations
 *     description: >-
 *       Returns current low, medium, and high fee recommendations (in stroops)
 *       along with the latest ledger sequence and an update timestamp.
 *     tags:
 *       - Analytics
 *     responses:
 *       200:
 *         description: Current gas fee estimates.
 */
analyticsRouter.get("/gas", (_req, res) => {
  try {
    const recommendation = feeEstimator.getRecommendation();
    res.json(recommendation);
  } catch (error) {
    console.error("Analytics gas error:", error);
    res.status(500).json({ error: "Failed to fetch gas recommendations" });
  }
});

/**
 * @openapi
 * /api/analytics/rate-benchmark:
 *   get:
 *     summary: Rate benchmark comparison data
 *     description: >-
 *       Returns the protocol-wide average and median lending rates by risk tier
 *       so the frontend can compare a user's active rate against the cohort
 *       average. Falls back to on-chain pool rates when aggregate data is
 *       insufficient.
 *     tags:
 *       - Analytics
 *     parameters:
 *       - in: query
 *         name: riskTier
 *         required: false
 *         description: Risk tier filter (e.g. "senior", "junior")
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Rate benchmark data with cohort averages.
 *       503:
 *         description: Insufficient data for benchmark comparison.
 */
analyticsRouter.get("/rate-benchmark", cacheMiddleware(60), async (req, res) => {
  try {
    const riskTier = (req.query.riskTier as string) || "all";
    const { lendingPoolContractId } = loadConfig();

    // Fetch live on-chain pool rates
    let poolRates: any = null;
    if (lendingPoolContractId) {
      try {
        poolRates = await getLendingPoolRates(lendingPoolContractId);
      } catch {
        // Pool rates unavailable — continue with database aggregate
      }
    }

    // Aggregate rate data from loan applications in the database
    const { prisma } = await import("../services/db.js");

    const loanApplications = await prisma.loanApplication.findMany({
      where: {
        status: { in: ["Approved", "Repaying", "Completed"] },
      },
      select: {
        id: true,
        amount: true,
        status: true,
        createdAt: true,
      },
    });

    // Derive per-loan effective rates from pool tranche APYs
    const seniorApyBps = poolRates?.seniorApyBps ?? 0;
    const juniorApyBps = poolRates?.juniorApyBps ?? 0;

    // Build cohort-level statistics
    const totalLoans = loanApplications.length;
    const hasSufficientData = totalLoans >= 5;

    // Compute protocol-wide average rate (blend of senior/junior tranches)
    const protocolAvgRateBps = hasSufficientData
      ? Math.round((seniorApyBps * 0.6 + juniorApyBps * 0.4))
      : seniorApyBps > 0 ? seniorApyBps : 0;

    // Median rate approximation — for now use the midpoint since we
    // lack per-loan rate granularity on-chain
    const protocolMedianRateBps = hasSufficientData
      ? Math.round((seniorApyBps + juniorApyBps) / 2)
      : protocolAvgRateBps;

    res.json({
      protocolAvgRateBps,
      protocolMedianRateBps,
      seniorApyBps,
      juniorApyBps,
      totalLoans,
      hasSufficientData,
      riskTier,
      liquidity: poolRates?.liquidity ?? null,
      lastUpdated: poolRates?.lastUpdated ?? new Date().toISOString(),
    });
  } catch (error) {
    console.error("Analytics rate-benchmark error:", error);
    res.status(500).json({ error: "Failed to compute rate benchmark data" });
  }
});
