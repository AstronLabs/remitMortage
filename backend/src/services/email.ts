import nodemailer from "nodemailer";
import logger from "../utils/logger.js";
import { loadConfig } from "../config.js";

const config = loadConfig();

const transporterConfig: any = {
  host: config.smtpHost,
  port: config.smtpPort,
  secure: config.smtpPort === 465,
};

if (config.smtpUser && config.smtpPass) {
  transporterConfig.auth = {
    user: config.smtpUser,
    pass: config.smtpPass,
  };
}

// Export transporter for testing/mocking
export const transporter = nodemailer.createTransport(transporterConfig);

/**
 * Returns a branded HTML email wrapper.
 */
export function getBrandedHtml(title: string, bodyContentHtml: string): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <style>
          body {
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            background-color: #f8fafc;
            margin: 0;
            padding: 0;
            color: #334155;
          }
          .container {
            max-width: 600px;
            margin: 40px auto;
            background-color: #ffffff;
            border-radius: 12px;
            overflow: hidden;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1);
            border: 1px solid #e2e8f0;
          }
          .header {
            background-color: #0f172a;
            color: #ffffff;
            padding: 32px 24px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
            letter-spacing: -0.025em;
          }
          .content {
            padding: 32px 24px;
            line-height: 1.6;
          }
          .cta-button {
            display: inline-block;
            background-color: #3b82f6;
            color: #ffffff !important;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 6px;
            font-weight: 600;
            margin-top: 24px;
            text-align: center;
          }
          .footer {
            background-color: #f1f5f9;
            padding: 24px;
            text-align: center;
            font-size: 12px;
            color: #64748b;
            border-top: 1px solid #e2e8f0;
          }
          .details-table {
            width: 100%;
            margin-top: 20px;
            border-collapse: collapse;
          }
          .details-table td {
            padding: 12px;
            border-bottom: 1px solid #f1f5f9;
          }
          .details-label {
            font-weight: 600;
            color: #475569;
            width: 35%;
          }
          .details-value {
            color: #0f172a;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>AstronLabs | RemitMortgage</h1>
          </div>
          <div class="content">
            ${bodyContentHtml}
          </div>
          <div class="footer">
            <p>This is an automated notification from RemitMortgage protocol.</p>
            <p>&copy; ${new Date().getFullYear()} AstronLabs. All rights reserved.</p>
          </div>
        </div>
      </body>
    </html>
  `;
}

/**
 * Sends a generic HTML email.
 */
export async function sendEmail(to: string, subject: string, htmlContent: string): Promise<boolean> {
  try {
    await transporter.sendMail({
      from: config.smtpFrom,
      to,
      subject,
      html: htmlContent,
    });
    return true;
  } catch (error) {
    logger.error(`[EmailService] Failed to send email to ${to}`, { error });
    return false;
  }
}

/**
 * Sends a branded Deposit Receipt HTML email.
 */
export async function sendDepositReceipt(to: string, amount: string, transactionId: string): Promise<boolean> {
  const subject = "Deposit Receipt - RemitMortgage";
  const body = `
    <h2>Deposit Confirmed</h2>
    <p>We successfully received your deposit of <strong>${amount} USDC</strong>. Your remittance progress has been updated accordingly.</p>
    <table class="details-table">
      <tr>
        <td class="details-label">Amount</td>
        <td class="details-value">${amount} USDC</td>
      </tr>
      <tr>
        <td class="details-label">Transaction Hash</td>
        <td class="details-value"><code>${transactionId}</code></td>
      </tr>
      <tr>
        <td class="details-label">Date</td>
        <td class="details-value">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p>Your deposit will be automatically processed into your mortgage escrow account.</p>
  `;
  return sendEmail(to, subject, getBrandedHtml(subject, body));
}

/**
 * Sends a branded Repayment Reminder HTML email.
 */
export async function sendRepaymentReminder(to: string, amount: string, dueDate: string): Promise<boolean> {
  const subject = "Repayment Reminder - RemitMortgage";
  const body = `
    <h2>Repayment Reminder</h2>
    <p>This is a reminder that an upcoming repayment is scheduled for your loan.</p>
    <table class="details-table">
      <tr>
        <td class="details-label">Amount Due</td>
        <td class="details-value"><strong>${amount} USDC</strong></td>
      </tr>
      <tr>
        <td class="details-label">Due Date</td>
        <td class="details-value">${new Date(dueDate).toLocaleDateString()}</td>
      </tr>
    </table>
    <p>Please ensure sufficient funds are available in your wallet or linked account before the due date to avoid grace period penalties.</p>
    <a href="#" class="cta-button">Make Repayment Now</a>
  `;
  return sendEmail(to, subject, getBrandedHtml(subject, body));
}

/**
 * Sends a branded Loan Status Update HTML email.
 */
export async function sendLoanStatusUpdate(to: string, loanId: string, status: string): Promise<boolean> {
  const subject = `Loan Application Status Update: ${status}`;
  const body = `
    <h2>Loan Status Update</h2>
    <p>Your loan application has been updated to status: <strong>${status}</strong>.</p>
    <table class="details-table">
      <tr>
        <td class="details-label">Loan Application ID</td>
        <td class="details-value"><code>${loanId}</code></td>
      </tr>
      <tr>
        <td class="details-label">New Status</td>
        <td class="details-value"><span style="color: #3b82f6; font-weight: bold;">${status}</span></td>
      </tr>
      <tr>
        <td class="details-label">Updated At</td>
        <td class="details-value">${new Date().toLocaleString()}</td>
      </tr>
    </table>
    <p>Log in to the dashboard to view more details about your application.</p>
  `;
  return sendEmail(to, subject, getBrandedHtml(subject, body));
}
