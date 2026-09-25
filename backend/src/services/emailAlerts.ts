// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Event-driven email alerting.
 *
 * Ledger events surfaced by the indexer are translated into branded SendGrid
 * emails. Every entry point swallows its own failures: a mail provider outage
 * must never stall or crash the indexer poll loop.
 */

import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";
import { getBrandedHtml } from "./email.js";
import { sendGridSend } from "./sendgrid.js";

export type AlertKind = "deposit" | "repay" | "milestone_approved";

export interface LedgerAlertEvent {
  kind: AlertKind;
  /** On-chain borrower address the event belongs to. */
  borrower: string;
  amount?: string;
  ledger?: number;
  contractId?: string;
  /** Milestone identifier, only present on milestone approvals. */
  milestoneId?: string;
}

interface RenderedTemplate {
  subject: string;
  html: string;
}

/**
 * Resolves the alert recipient for a borrower address. Uses the configured
 * address -> email map, then the default recipient, then gives up.
 */
export function resolveRecipient(borrower: string): string | null {
  const config = loadConfig();
  return config.alertRecipients[borrower] || config.alertDefaultRecipient || null;
}

function detailsRow(label: string, value: string): string {
  return `
      <tr>
        <td class="details-label">${label}</td>
        <td class="details-value">${value}</td>
      </tr>`;
}

function depositTemplate(event: LedgerAlertEvent): RenderedTemplate {
  const subject = "Deposit Received - RemitMortgage";
  const body = `
    <h2>Deposit Received</h2>
    <p>A deposit of <strong>${event.amount ?? "0"} USDC</strong> was recorded on-chain against your mortgage escrow.</p>
    <table class="details-table">
      ${detailsRow("Amount", `${event.amount ?? "0"} USDC`)}
      ${detailsRow("Borrower", `<code>${event.borrower}</code>`)}
      ${detailsRow("Ledger", String(event.ledger ?? "-"))}
    </table>
    <p>No action is required. Your remittance timeline has been updated automatically.</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

function repaymentTemplate(event: LedgerAlertEvent): RenderedTemplate {
  const subject = "Repayment Recorded - RemitMortgage";
  const body = `
    <h2>Repayment Recorded</h2>
    <p>We applied a repayment of <strong>${event.amount ?? "0"} USDC</strong> to your outstanding loan balance.</p>
    <table class="details-table">
      ${detailsRow("Amount", `${event.amount ?? "0"} USDC`)}
      ${detailsRow("Borrower", `<code>${event.borrower}</code>`)}
      ${detailsRow("Ledger", String(event.ledger ?? "-"))}
    </table>
    <p>Log in to the dashboard to review your updated amortization schedule.</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

function milestoneApprovedTemplate(event: LedgerAlertEvent): RenderedTemplate {
  const subject = "Milestone Approved - RemitMortgage";
  const body = `
    <h2>Milestone Approved</h2>
    <p>A construction milestone on your project has been approved and funds are cleared for release.</p>
    <table class="details-table">
      ${detailsRow("Milestone", `<code>${event.milestoneId ?? "-"}</code>`)}
      ${detailsRow("Released Amount", `${event.amount ?? "0"} USDC`)}
      ${detailsRow("Borrower", `<code>${event.borrower}</code>`)}
      ${detailsRow("Ledger", String(event.ledger ?? "-"))}
    </table>
    <p>Your contractor can now proceed with the next stage of work.</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

const TEMPLATES: Record<AlertKind, (event: LedgerAlertEvent) => RenderedTemplate> = {
  deposit: depositTemplate,
  repay: repaymentTemplate,
  milestone_approved: milestoneApprovedTemplate,
};

/** Renders the email body for a ledger event without dispatching it. */
export function renderAlert(event: LedgerAlertEvent): RenderedTemplate | null {
  const template = TEMPLATES[event.kind];
  return template ? template(event) : null;
}

/**
 * Renders and dispatches the alert for a ledger event.
 * Resolves `false` instead of rejecting on any failure.
 */
export async function sendLedgerAlert(event: LedgerAlertEvent): Promise<boolean> {
  try {
    const rendered = renderAlert(event);
    if (!rendered) return false;

    const recipient = resolveRecipient(event.borrower);
    if (!recipient) {
      logger.debug(
        `[email-alerts] no recipient mapped for ${event.borrower}, skipping ${event.kind} alert`
      );
      return false;
    }

    return await sendGridSend({
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`[email-alerts] ${event.kind} alert failed`, { error: detail });
    return false;
  }
}

/**
 * Fire-and-forget entry point for the indexer callback pipeline. Returns
 * immediately; delivery and any failure are handled in the background.
 */
export function dispatchLedgerAlert(event: LedgerAlertEvent): void {
  void sendLedgerAlert(event).catch((error) => {
    logger.error("[email-alerts] unexpected dispatch error", { error });
  });
}
