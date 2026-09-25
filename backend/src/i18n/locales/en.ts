// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const en = {
  "email.deposit_receipt.subject": "Deposit Receipt - RemitMortgage",
  "email.deposit_receipt.title": "Deposit Confirmed",
  "email.deposit_receipt.body": "We successfully received your deposit of <strong>{amount} USDC</strong>. Your remittance progress has been updated accordingly.",
  "email.deposit_receipt.amount_label": "Amount",
  "email.deposit_receipt.tx_hash_label": "Transaction Hash",
  "email.deposit_receipt.date_label": "Date",
  "email.deposit_receipt.footer": "Your deposit will be automatically processed into your mortgage escrow account.",

  "email.repayment_reminder.subject": "Repayment Reminder - RemitMortgage",
  "email.repayment_reminder.title": "Repayment Reminder",
  "email.repayment_reminder.body": "This is a reminder that an upcoming repayment is scheduled for your loan.",
  "email.repayment_reminder.amount_due_label": "Amount Due",
  "email.repayment_reminder.due_date_label": "Due Date",
  "email.repayment_reminder.footer": "Please ensure sufficient funds are available in your wallet or linked account before the due date to avoid grace period penalties.",
  "email.repayment_reminder.cta": "Make Repayment Now",

  "email.loan_status.subject": "Loan Application Status Update: {status}",
  "email.loan_status.title": "Loan Status Update",
  "email.loan_status.body": "Your loan application has been updated to status: <strong>{status}</strong>.",
  "email.loan_status.loan_id_label": "Loan Application ID",
  "email.loan_status.new_status_label": "New Status",
  "email.loan_status.updated_at_label": "Updated At",
  "email.loan_status.footer": "Log in to the dashboard to view more details about your application.",

  "email.lockout.subject": "Security Alert: Account Locked - RemitMortgage",
  "email.lockout.title": "Security Alert: Account Temporarily Locked",
  "email.lockout.body": "Multiple consecutive failed login attempts were detected on your RemitMortgage account.",
  "email.lockout.locked_message": "To protect your financial records and assets from unauthorized access, your account has been temporarily locked for <strong>{lockoutMinutes} minute(s)</strong>.",
  "email.lockout.duration_label": "Lockout Duration",
  "email.lockout.ip_label": "Originating IP Address",
  "email.lockout.timestamp_label": "Timestamp",
  "email.lockout.footer": "If this was not you, someone may be attempting to guess your password. We strongly recommend resetting your password immediately once the lockout period expires.",
  "email.lockout.cta": "Reset Password",

  "email.alert_deposit.subject": "Deposit Received - RemitMortgage",
  "email.alert_deposit.title": "Deposit Received",
  "email.alert_deposit.body": "A deposit of <strong>{amount} USDC</strong> was recorded on-chain against your mortgage escrow.",
  "email.alert_deposit.amount_label": "Amount",
  "email.alert_deposit.borrower_label": "Borrower",
  "email.alert_deposit.ledger_label": "Ledger",
  "email.alert_deposit.footer": "No action is required. Your remittance timeline has been updated automatically.",

  "email.alert_repay.subject": "Repayment Recorded - RemitMortgage",
  "email.alert_repay.title": "Repayment Recorded",
  "email.alert_repay.body": "We applied a repayment of <strong>{amount} USDC</strong> to your outstanding loan balance.",
  "email.alert_repay.amount_label": "Amount",
  "email.alert_repay.borrower_label": "Borrower",
  "email.alert_repay.ledger_label": "Ledger",
  "email.alert_repay.footer": "Log in to the dashboard to review your updated amortization schedule.",

  "email.alert_milestone.subject": "Milestone Approved - RemitMortgage",
  "email.alert_milestone.title": "Milestone Approved",
  "email.alert_milestone.body": "A construction milestone on your project has been approved and funds are cleared for release.",
  "email.alert_milestone.milestone_label": "Milestone",
  "email.alert_milestone.released_label": "Released Amount",
  "email.alert_milestone.borrower_label": "Borrower",
  "email.alert_milestone.ledger_label": "Ledger",
  "email.alert_milestone.footer": "Your contractor can now proceed with the next stage of work.",
} as const;

export default en;
