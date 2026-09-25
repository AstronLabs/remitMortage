// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { type Locale, t } from "../i18n/index.js";
import { getBrandedHtml } from "../services/email.js";

export interface DepositReceiptParams {
  amount: string;
  transactionId: string;
}

export interface RepaymentReminderParams {
  amount: string;
  dueDate: string;
}

export interface LoanStatusParams {
  loanId: string;
  status: string;
}

export interface LockoutParams {
  lockoutMinutes: number;
  ipAddress?: string;
}

export interface LedgerAlertParams {
  amount: string;
  borrower: string;
  ledger: number;
  milestoneId?: string;
}

export function renderDepositReceipt(locale: Locale, params: DepositReceiptParams) {
  const subject = t(locale, "email.deposit_receipt.subject");
  const body = `
    <h2>${t(locale, "email.deposit_receipt.title")}</h2>
    <p>${t(locale, "email.deposit_receipt.body", { amount: params.amount })}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.deposit_receipt.amount_label")}</td>
        <td class="details-value">${params.amount} USDC</td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.deposit_receipt.tx_hash_label")}</td>
        <td class="details-value"><code>${params.transactionId}</code></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.deposit_receipt.date_label")}</td>
        <td class="details-value">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p>${t(locale, "email.deposit_receipt.footer")}</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

export function renderRepaymentReminder(locale: Locale, params: RepaymentReminderParams) {
  const subject = t(locale, "email.repayment_reminder.subject");
  const body = `
    <h2>${t(locale, "email.repayment_reminder.title")}</h2>
    <p>${t(locale, "email.repayment_reminder.body")}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.repayment_reminder.amount_due_label")}</td>
        <td class="details-value"><strong>${params.amount} USDC</strong></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.repayment_reminder.due_date_label")}</td>
        <td class="details-value">${new Date(params.dueDate).toLocaleDateString()}</td>
      </tr>
    </table>
    <p>${t(locale, "email.repayment_reminder.footer")}</p>
    <a href="#" class="cta-button">${t(locale, "email.repayment_reminder.cta")}</a>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

export function renderLoanStatusUpdate(locale: Locale, params: LoanStatusParams) {
  const subject = t(locale, "email.loan_status.subject", { status: params.status });
  const body = `
    <h2>${t(locale, "email.loan_status.title")}</h2>
    <p>${t(locale, "email.loan_status.body", { status: params.status })}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.loan_status.loan_id_label")}</td>
        <td class="details-value"><code>${params.loanId}</code></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.loan_status.new_status_label")}</td>
        <td class="details-value"><span style="color: #3b82f6; font-weight: bold;">${params.status}</span></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.loan_status.updated_at_label")}</td>
        <td class="details-value">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p>${t(locale, "email.loan_status.footer")}</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

export function renderLockoutNotification(locale: Locale, params: LockoutParams) {
  const subject = t(locale, "email.lockout.subject");
  const body = `
    <h2 style="color: #ef4444;">${t(locale, "email.lockout.title")}</h2>
    <p>${t(locale, "email.lockout.body")}</p>
    <p>${t(locale, "email.lockout.locked_message", { lockoutMinutes: params.lockoutMinutes })}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.lockout.duration_label")}</td>
        <td class="details-value"><strong>${params.lockoutMinutes} minute(s)</strong></td>
      </tr>
      ${
        params.ipAddress
          ? `<tr>
        <td class="details-label">${t(locale, "email.lockout.ip_label")}</td>
        <td class="details-value"><code>${params.ipAddress}</code></td>
      </tr>`
          : ""
      }
      <tr>
        <td class="details-label">${t(locale, "email.lockout.timestamp_label")}</td>
        <td class="details-value">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p style="margin-top: 20px;">${t(locale, "email.lockout.footer")}</p>
    <a href="#" class="cta-button" style="background-color: #ef4444;">${t(locale, "email.lockout.cta")}</a>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

export function renderDepositAlert(locale: Locale, params: LedgerAlertParams) {
  const subject = t(locale, "email.alert_deposit.subject");
  const body = `
    <h2>${t(locale, "email.alert_deposit.title")}</h2>
    <p>${t(locale, "email.alert_deposit.body", { amount: params.amount })}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.alert_deposit.amount_label")}</td>
        <td class="details-value">${params.amount} USDC</td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_deposit.borrower_label")}</td>
        <td class="details-value"><code>${params.borrower}</code></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_deposit.ledger_label")}</td>
        <td class="details-value">${String(params.ledger)}</td>
      </tr>
    </table>
    <p>${t(locale, "email.alert_deposit.footer")}</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

export function renderRepaymentAlert(locale: Locale, params: LedgerAlertParams) {
  const subject = t(locale, "email.alert_repay.subject");
  const body = `
    <h2>${t(locale, "email.alert_repay.title")}</h2>
    <p>${t(locale, "email.alert_repay.body", { amount: params.amount })}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.alert_repay.amount_label")}</td>
        <td class="details-value">${params.amount} USDC</td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_repay.borrower_label")}</td>
        <td class="details-value"><code>${params.borrower}</code></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_repay.ledger_label")}</td>
        <td class="details-value">${String(params.ledger)}</td>
      </tr>
    </table>
    <p>${t(locale, "email.alert_repay.footer")}</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}

export function renderMilestoneApprovedAlert(locale: Locale, params: LedgerAlertParams) {
  const subject = t(locale, "email.alert_milestone.subject");
  const body = `
    <h2>${t(locale, "email.alert_milestone.title")}</h2>
    <p>${t(locale, "email.alert_milestone.body")}</p>
    <table class="details-table">
      <tr>
        <td class="details-label">${t(locale, "email.alert_milestone.milestone_label")}</td>
        <td class="details-value"><code>${params.milestoneId ?? "-"}</code></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_milestone.released_label")}</td>
        <td class="details-value">${params.amount} USDC</td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_milestone.borrower_label")}</td>
        <td class="details-value"><code>${params.borrower}</code></td>
      </tr>
      <tr>
        <td class="details-label">${t(locale, "email.alert_milestone.ledger_label")}</td>
        <td class="details-value">${String(params.ledger)}</td>
      </tr>
    </table>
    <p>${t(locale, "email.alert_milestone.footer")}</p>
  `;
  return { subject, html: getBrandedHtml(subject, body) };
}
