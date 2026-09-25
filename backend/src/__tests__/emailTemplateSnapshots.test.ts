// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { type Locale, SUPPORTED_LOCALES } from "../i18n/index.js";
import {
  renderDepositReceipt,
  renderRepaymentReminder,
  renderLoanStatusUpdate,
  renderLockoutNotification,
  renderDepositAlert,
  renderRepaymentAlert,
  renderMilestoneApprovedAlert,
} from "../services/emailTemplates.js";

const SNAPSHOT_DIR = "__snapshots__";

function normalizeHtml(html: string): string {
  return html
    .replace(/\d{1,2}\/\d{1,2}\/\d{4},\s\d{1,2}:\d{2}:\d{2}\s(AM|PM)/g, "<DATE>")
    .replace(/\d{1,2}\/\d{1,2}\/\d{4}/g, "<DATE>")
    .replace(/©\s\d{4}/g, "© <YEAR>");
}

describe("Email Template Snapshots", () => {
  describe.each(SUPPORTED_LOCALES)("Locale: %s", (locale) => {
    describe("Deposit Receipt", () => {
      it("renders correctly", () => {
        const result = renderDepositReceipt(locale, {
          amount: "500.00",
          transactionId: "tx_abc123def456",
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderDepositReceipt(locale, {
          amount: "100.00",
          transactionId: "tx_test",
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{amount}");
        expect(result.html).not.toContain("{transactionId}");
      });
    });

    describe("Repayment Reminder", () => {
      it("renders correctly", () => {
        const result = renderRepaymentReminder(locale, {
          amount: "250.00",
          dueDate: "2026-09-15",
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderRepaymentReminder(locale, {
          amount: "100.00",
          dueDate: "2026-01-01",
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{amount}");
        expect(result.html).not.toContain("{dueDate}");
      });
    });

    describe("Loan Status Update", () => {
      it("renders correctly", () => {
        const result = renderLoanStatusUpdate(locale, {
          loanId: "loan_789",
          status: "Approved",
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderLoanStatusUpdate(locale, {
          loanId: "loan_test",
          status: "Pending",
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{loanId}");
        expect(result.html).not.toContain("{status}");
      });
    });

    describe("Lockout Notification", () => {
      it("renders correctly with IP address", () => {
        const result = renderLockoutNotification(locale, {
          lockoutMinutes: 15,
          ipAddress: "192.168.1.100",
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("renders correctly without IP address", () => {
        const result = renderLockoutNotification(locale, {
          lockoutMinutes: 30,
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderLockoutNotification(locale, {
          lockoutMinutes: 10,
          ipAddress: "10.0.0.1",
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{lockoutMinutes}");
        expect(result.html).not.toContain("{ipAddress}");
      });
    });

    describe("Deposit Alert", () => {
      it("renders correctly", () => {
        const result = renderDepositAlert(locale, {
          amount: "1000.00",
          borrower: "GABC123DEF456",
          ledger: 12345,
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderDepositAlert(locale, {
          amount: "500.00",
          borrower: "GTEST",
          ledger: 1,
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{amount}");
        expect(result.html).not.toContain("{borrower}");
      });
    });

    describe("Repayment Alert", () => {
      it("renders correctly", () => {
        const result = renderRepaymentAlert(locale, {
          amount: "300.00",
          borrower: "GABC123DEF456",
          ledger: 67890,
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderRepaymentAlert(locale, {
          amount: "200.00",
          borrower: "GTEST",
          ledger: 1,
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{amount}");
      });
    });

    describe("Milestone Approved Alert", () => {
      it("renders correctly", () => {
        const result = renderMilestoneApprovedAlert(locale, {
          amount: "5000.00",
          borrower: "GABC123DEF456",
          milestoneId: "milestone_42",
          ledger: 99999,
        });
        expect(result.subject).toBeTruthy();
        expect(result.html).toBeTruthy();
        expect(normalizeHtml(result.html)).toMatchSnapshot();
      });

      it("contains no raw i18n keys", () => {
        const result = renderMilestoneApprovedAlert(locale, {
          amount: "1000.00",
          borrower: "GTEST",
          milestoneId: "m1",
          ledger: 1,
        });
        expect(result.html).not.toMatch(/email\.\w+\.\w+/);
        expect(result.html).not.toContain("{amount}");
        expect(result.html).not.toContain("{milestoneId}");
      });
    });
  });

  describe("Locale fallback safety", () => {
    it.each(SUPPORTED_LOCALES)("locale %s does not fall back to English placeholder text", (locale) => {
      if (locale === "en") return;

      const deposit = renderDepositReceipt(locale, { amount: "100", transactionId: "tx1" });
      const enDeposit = renderDepositReceipt("en", { amount: "100", transactionId: "tx1" });

      expect(deposit.subject).not.toBe(enDeposit.subject);
    });
  });
});
