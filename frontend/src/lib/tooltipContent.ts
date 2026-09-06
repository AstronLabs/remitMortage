/**
 * Tooltip content sourced from a versioned JSON content file.
 *
 * This file acts as a lightweight CMS — content can be updated without
 * requiring a frontend redeploy when served via a CDN or API endpoint.
 *
 * To switch to a headless CMS:
 *   1. Replace the `fetchTooltipContent()` call with a CMS API fetch.
 *   2. Cache the response client-side with a TTL matching the CMS refresh rate.
 *
 * Format:
 *   - Each key is a field identifier (kebab-case).
 *   - `label`: Display name for the field.
 *   - `tooltip`: The help text shown in the tooltip.
 */
export interface TooltipEntry {
  label: string;
  tooltip: string;
}

export type TooltipContentMap = Record<string, TooltipEntry>;

/**
 * Default tooltip content for complex mortgage/protocol fields.
 * Version this file (e.g. v1, v2) when making breaking content changes.
 */
const TOOLTIP_CONTENT: TooltipContentMap = {
  "ltv": {
    label: "Loan-to-Value (LTV)",
    tooltip:
      "The ratio of the loan amount to the property's appraised value, expressed as a percentage. A lower LTV means you're borrowing less relative to the property value, which typically results in better loan terms.",
  },
  "apy": {
    label: "Annual Percentage Yield (APY)",
    tooltip:
      "The effective annual rate of return on your deposit, accounting for compound interest. This is the real yield you earn over a year, not just the nominal rate.",
  },
  "collateralization-ratio": {
    label: "Collateralization Ratio",
    tooltip:
      "The ratio of collateral value to the outstanding loan balance. A higher ratio provides more safety margin for lenders and may qualify borrowers for better interest rates.",
  },
  "interest-rate": {
    label: "Interest Rate",
    tooltip:
      "The annual cost of borrowing expressed as a percentage of the principal. Rates in this protocol range from 4% to 18% APR, determined by your verification score tier.",
  },
  "tranche": {
    label: "Tranche",
    tooltip:
      "A risk stratification layer for investor deposits. Senior tranche offers lower, protected yields. Junior tranche offers higher, variable yields but absorbs losses first.",
  },
  "savings-target": {
    label: "Savings Target",
    tooltip:
      "The 30% down-payment amount you need to accumulate in your escrow account before the lending pool will approve your mortgage loan.",
  },
  "grace-period": {
    label: "Grace Period",
    tooltip:
      "The number of days after a payment due date before late penalties begin to accrue. Payments made within the grace period are considered on-time.",
  },
  "early-withdrawal-penalty": {
    label: "Early Withdrawal Penalty",
    tooltip:
      "A fee charged if you withdraw funds from your escrow before reaching your savings target. The penalty decreases over time across four tiers.",
  },
  "milestone-disbursement": {
    label: "Milestone Disbursement",
    tooltip:
      "Loan funds are released in tranches tied to construction milestones, not all at once. Each disbursement requires evidence of completed work and multisig approval.",
  },
  "verification-score": {
    label: "Verification Score",
    tooltip:
      "Your creditworthiness score derived from verified remittance history. Higher scores unlock lower interest rates (Excellent: 4% APR, Good: 6%, Fair: 8%).",
  },
  "daily-borrow-limit": {
    label: "Daily Borrow Limit",
    tooltip:
      "The maximum total amount that can be borrowed across all loans in a single day. This protects the pool from sudden liquidity drain.",
  },
  "fee-switch": {
    label: "Protocol Fee Switch",
    tooltip:
      "A governance-controlled percentage of loan interest that is routed to the protocol treasury instead of investors. Defaults to 0% (off).",
  },
};

/**
 * Fetch tooltip content. In production, this could be replaced with a
 * CMS API call. The default implementation returns the static content
 * above, enabling content updates without redeployment when served from
 * a CDN edge cache or API proxy.
 */
export async function fetchTooltipContent(): Promise<TooltipContentMap> {
  // Static fallback — replace with CMS fetch when ready:
  // const res = await fetch(`${CMS_URL}/tooltips`);
  // return res.json();
  return TOOLTIP_CONTENT;
}
