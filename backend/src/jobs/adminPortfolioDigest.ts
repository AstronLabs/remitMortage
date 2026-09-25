// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Admin Portfolio Digest job (issue #477).
 *
 * Aggregates the same protocol-health metrics the admin dashboard shows —
 * TVL, loan performance, and disbursement/milestone progress — and emails a
 * branded HTML summary to the configured admin recipients on a schedule.
 *
 * The digest reads its numbers from the very same analytics accessors that
 * back the `/api/analytics/*` endpoints (`getProtocolOverview`,
 * `getLoanPerformance`, `getDisbursementProgress`), so the figures in the
 * email match what the live dashboard renders at generation time.
 */

import { getBrandedHtml, sendEmail } from "../services/email.js";
import {
  getProtocolOverview,
  getLoanPerformance,
  getDisbursementProgress,
  type ProtocolOverview,
  type LoanPerformance,
  type DisbursementProgress,
  type AnalyticsDeps,
} from "../services/analytics.js";
import logger from "../utils/logger.js";

/** Selectable metric sections an admin can include in their digest. */
export type DigestSection = "overview" | "loans" | "disbursement";

export const ALL_SECTIONS: readonly DigestSection[] = [
  "overview",
  "loans",
  "disbursement",
];

const STROOPS_PER_UNIT = 10_000_000;

/** Formats a stroop-denominated string as a human-readable USDC amount. */
function formatUsdc(stroops: string): string {
  let units: number;
  try {
    // Divide with BigInt to avoid precision loss on large balances, then
    // render the fractional part separately.
    const asBigInt = BigInt(stroops);
    const whole = asBigInt / BigInt(STROOPS_PER_UNIT);
    const frac = asBigInt % BigInt(STROOPS_PER_UNIT);
    units = Number(whole) + Number(frac) / STROOPS_PER_UNIT;
  } catch {
    units = Number(stroops) / STROOPS_PER_UNIT || 0;
  }
  return units.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export interface PortfolioDigestData {
  overview: ProtocolOverview;
  loans: LoanPerformance;
  disbursement: DisbursementProgress;
  generatedAt: Date;
}

/**
 * Gathers the digest metrics from the shared analytics accessors so the
 * values are identical to the dashboard's `/api/analytics/*` responses.
 */
export function gatherPortfolioDigest(deps?: AnalyticsDeps): PortfolioDigestData {
  return {
    overview: getProtocolOverview(deps),
    loans: getLoanPerformance(deps),
    disbursement: getDisbursementProgress(deps),
    generatedAt: deps?.now?.() ?? new Date(),
  };
}

function overviewRows(overview: ProtocolOverview): string {
  return `
    <tr>
      <td class="details-label">Total Value Locked</td>
      <td class="details-value"><strong>$${formatUsdc(overview.tvl.total)} USDC</strong></td>
    </tr>
    <tr>
      <td class="details-label">— Escrow</td>
      <td class="details-value">$${formatUsdc(overview.tvl.escrow)} USDC</td>
    </tr>
    <tr>
      <td class="details-label">— Lending Pool</td>
      <td class="details-value">$${formatUsdc(overview.tvl.lendingPool)} USDC</td>
    </tr>
    <tr>
      <td class="details-label">Borrowers</td>
      <td class="details-value">${overview.totalBorrowers}</td>
    </tr>
    <tr>
      <td class="details-label">Investors</td>
      <td class="details-value">${overview.totalInvestors}</td>
    </tr>
    <tr>
      <td class="details-label">Total Loans</td>
      <td class="details-value">${overview.totalLoans}</td>
    </tr>`;
}

function loanRows(loans: LoanPerformance): string {
  const delinquencyColor = loans.defaultedLoans > 0 ? "#dc2626" : "#16a34a";
  return `
    <tr>
      <td class="details-label">Active Loans</td>
      <td class="details-value"><strong>${loans.activeLoans}</strong></td>
    </tr>
    <tr>
      <td class="details-label">Repaid Loans</td>
      <td class="details-value">${loans.repaidLoans}</td>
    </tr>
    <tr>
      <td class="details-label">Delinquencies (defaulted)</td>
      <td class="details-value" style="color: ${delinquencyColor};">
        <strong>${loans.defaultedLoans}</strong> (${loans.defaultRate}%)
      </td>
    </tr>
    <tr>
      <td class="details-label">Repayment Rate</td>
      <td class="details-value">${loans.repaymentRate}%</td>
    </tr>
    <tr>
      <td class="details-label">On-Time Payments</td>
      <td class="details-value">${loans.onTimePaymentPercentage}%</td>
    </tr>`;
}

function disbursementRows(disbursement: DisbursementProgress): string {
  return `
    <tr>
      <td class="details-label">Total Disbursed</td>
      <td class="details-value"><strong>$${formatUsdc(disbursement.totalDisbursed)} USDC</strong></td>
    </tr>
    <tr>
      <td class="details-label">Milestones Completed</td>
      <td class="details-value">${disbursement.milestonesCompleted}</td>
    </tr>
    <tr>
      <td class="details-label">Pending Reviews</td>
      <td class="details-value"><strong>${disbursement.milestonesPending}</strong></td>
    </tr>`;
}

/**
 * Renders the digest as branded HTML. Pure — given the same data and section
 * selection it always produces the same markup, which keeps it easy to test.
 */
export function buildPortfolioDigestHtml(
  data: PortfolioDigestData,
  sections: readonly DigestSection[] = ALL_SECTIONS
): string {
  const included = ALL_SECTIONS.filter((s) => sections.includes(s));
  const blocks: string[] = [];

  if (included.includes("overview")) {
    blocks.push(`
      <h2>Protocol Overview</h2>
      <table class="details-table">${overviewRows(data.overview)}</table>
    `);
  }
  if (included.includes("loans")) {
    blocks.push(`
      <h2>Loan Performance</h2>
      <table class="details-table">${loanRows(data.loans)}</table>
    `);
  }
  if (included.includes("disbursement")) {
    blocks.push(`
      <h2>Disbursement &amp; Milestones</h2>
      <table class="details-table">${disbursementRows(data.disbursement)}</table>
    `);
  }

  const generated = data.generatedAt.toUTCString();
  const body = `
    <h2>Portfolio Summary</h2>
    <p>Here is the latest snapshot of protocol health as of <strong>${generated}</strong>.</p>
    ${blocks.join("\n")}
    <p style="margin-top: 24px;">These figures reflect the same data shown on the live admin dashboard at generation time.</p>
    <a href="#" class="cta-button">Open Admin Dashboard</a>
  `;
  return getBrandedHtml("RemitMortgage — Admin Portfolio Summary", body);
}

/** Parses `ADMIN_DIGEST_RECIPIENTS` (comma-separated emails) into a list. */
export function getConfiguredRecipients(): string[] {
  return (process.env.ADMIN_DIGEST_RECIPIENTS || "")
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0);
}

/**
 * Parses `ADMIN_DIGEST_SECTIONS` (comma-separated section names) into a valid
 * section list, defaulting to all sections when unset or malformed.
 */
export function getConfiguredSections(): DigestSection[] {
  const raw = (process.env.ADMIN_DIGEST_SECTIONS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is DigestSection => (ALL_SECTIONS as readonly string[]).includes(s));
  return raw.length > 0 ? raw : [...ALL_SECTIONS];
}

export interface DigestJobOptions {
  recipients?: string[];
  sections?: readonly DigestSection[];
  data?: PortfolioDigestData;
  deps?: AnalyticsDeps;
  /** Injectable sender for tests; defaults to the SMTP email service. */
  send?: (to: string, subject: string, html: string) => Promise<boolean>;
}

const DIGEST_SUBJECT = "RemitMortgage — Admin Portfolio Summary";

/**
 * Builds the digest and dispatches it to every configured admin recipient.
 * Exported for direct invocation from the scheduler, tests, or an admin trigger.
 */
export async function runAdminPortfolioDigestJob(
  options: DigestJobOptions = {}
): Promise<{ sent: number; failed: number; recipients: number }> {
  const recipients = options.recipients ?? getConfiguredRecipients();
  const sections = options.sections ?? getConfiguredSections();
  const send = options.send ?? sendEmail;

  if (recipients.length === 0) {
    logger.warn(
      "[admin-digest] No ADMIN_DIGEST_RECIPIENTS configured, skipping portfolio digest"
    );
    return { sent: 0, failed: 0, recipients: 0 };
  }

  const data = options.data ?? gatherPortfolioDigest(options.deps);
  const html = buildPortfolioDigestHtml(data, sections);

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    const ok = await send(recipient, DIGEST_SUBJECT, html);
    if (ok) {
      sent += 1;
    } else {
      failed += 1;
    }
  }

  logger.info(
    `[admin-digest] Portfolio digest dispatched: ${sent} sent, ${failed} failed of ${recipients.length} recipients`
  );
  return { sent, failed, recipients: recipients.length };
}
