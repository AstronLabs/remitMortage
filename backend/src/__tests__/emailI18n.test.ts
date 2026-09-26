/**
 * Tests for email template localization (email-template-localization feature).
 */

import {
  resolveLocale,
  getEmailTranslator,
  SUPPORTED_LOCALES,
} from "../i18n/emailI18n.js";
import {
  emailTranslations,
  EmailTranslationCatalogue,
} from "../i18n/emailTranslations.js";
import {
  getBrandedHtml,
  sendDepositReceipt,
  sendRepaymentReminder,
  sendLoanStatusUpdate,
  transporter,
} from "../services/email.js";

jest.mock("../config.js", () => ({
  loadConfig: () => ({
    smtpHost: "localhost",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "no-reply@test.com",
    kmsKeyVersions: { v1: "1".repeat(64) },
    kmsActiveKeyVersion: "v1",
  }),
}));

// ── Suite 1: resolveLocale ────────────────────────────────────────────────────
describe("resolveLocale", () => {
  it.each(SUPPORTED_LOCALES as unknown as string[])(
    "returns '%s' for exact match",
    (locale) => expect(resolveLocale(locale)).toBe(locale)
  );

  it("returns 'en' for null", () => expect(resolveLocale(null)).toBe("en"));
  it("returns 'en' for undefined", () => expect(resolveLocale(undefined)).toBe("en"));
  it("returns 'en' for empty string", () => expect(resolveLocale("")).toBe("en"));
  it("returns 'en' for unsupported locale 'de'", () => expect(resolveLocale("de")).toBe("en"));
  it("returns 'en' for unsupported locale 'ja'", () => expect(resolveLocale("ja")).toBe("en"));
  it("strips BCP-47 subtag: 'pt-BR' -> 'pt'", () => expect(resolveLocale("pt-BR")).toBe("pt"));
  it("strips BCP-47 subtag: 'zh-TW' -> 'zh'", () => expect(resolveLocale("zh-TW")).toBe("zh"));
  it("strips BCP-47 subtag: 'fr-CA' -> 'fr'", () => expect(resolveLocale("fr-CA")).toBe("fr"));
  it("is case-insensitive: 'ES' -> 'es'", () => expect(resolveLocale("ES")).toBe("es"));
});

// ── Suite 2: getEmailTranslator – locale selection ────────────────────────────
describe("getEmailTranslator – locale selection", () => {
  it("returns English strings for locale=en", () => {
    const t = getEmailTranslator("en");
    expect(t("deposit_heading")).toBe("Deposit Confirmed");
  });

  it("returns Spanish strings for locale=es", () => {
    const t = getEmailTranslator("es");
    expect(t("deposit_heading")).toBe("Depósito Confirmado");
  });

  it("returns Portuguese strings for locale=pt", () => {
    const t = getEmailTranslator("pt");
    expect(t("deposit_heading")).toBe("Depósito Confirmado");
  });

  it("returns French strings for locale=fr", () => {
    const t = getEmailTranslator("fr");
    expect(t("deposit_heading")).toBe("Dépôt Confirmé");
  });

  it("returns Chinese strings for locale=zh", () => {
    const t = getEmailTranslator("zh");
    expect(t("deposit_heading")).toBe("存款已确认");
  });

  it("falls back to English for unsupported locale 'de'", () => {
    const t = getEmailTranslator("de");
    expect(t("deposit_heading")).toBe("Deposit Confirmed");
  });

  it("falls back to English for null locale", () => {
    const t = getEmailTranslator(null);
    expect(t("deposit_heading")).toBe("Deposit Confirmed");
  });

  it("falls back to English for undefined locale", () => {
    const t = getEmailTranslator(undefined);
    expect(t("repayment_heading")).toBe("Repayment Reminder");
  });
});

// ── Suite 3: getEmailTranslator – variable interpolation ─────────────────────
describe("getEmailTranslator – variable interpolation", () => {
  it("interpolates a single {{var}}", () => {
    const t = getEmailTranslator("en");
    expect(t("grace_period_body", { days: "3" })).toContain("3-day grace period");
  });

  it("interpolates multiple vars", () => {
    const t = getEmailTranslator("en");
    const result = t("guarantor_missed_payment_body", { missed: "2", max: "3", fee: "50" });
    expect(result).toContain("2 of 3");
    expect(result).toContain("$50");
  });

  it("leaves unreplaced {{var}} in place when var is missing", () => {
    const t = getEmailTranslator("en");
    const result = t("loan_status_subject"); // has {{status}} but no vars passed
    expect(result).toContain("{{status}}");
  });

  it("interpolates {{var}} in non-English locale", () => {
    const t = getEmailTranslator("es");
    const result = t("grace_period_body", { days: "3" });
    expect(result).toContain("3");
    expect(result).not.toContain("{{days}}");
  });

  it("interpolates {{loanId}} in guarantor liability body", () => {
    const t = getEmailTranslator("en");
    const result = t("guarantor_liability_body", { loanId: "loan-abc-123" });
    expect(result).toContain("loan-abc-123");
    expect(result).not.toContain("{{loanId}}");
  });
});

// ── Suite 4: no raw translation keys in rendered output ───────────────────────
describe("No raw translation keys rendered", () => {
  const RAW_KEY_PATTERN = /^[a-z][a-z0-9_]+_[a-z][a-z0-9_]+$/; // e.g. deposit_heading

  for (const locale of SUPPORTED_LOCALES) {
    it(`locale=${locale}: no key renders as itself`, () => {
      const t = getEmailTranslator(locale);
      const catalogue = emailTranslations[locale];
      for (const key of Object.keys(catalogue) as Array<keyof EmailTranslationCatalogue>) {
        const rendered = t(key);
        // A rendered value must not look exactly like a raw key
        expect(RAW_KEY_PATTERN.test(rendered)).toBe(false);
      }
    });
  }
});

// ── Suite 5: getBrandedHtml locale integration ────────────────────────────────
describe("getBrandedHtml locale integration", () => {
  it("renders English footer for locale=en", () => {
    const html = getBrandedHtml("Test", "<p>body</p>", "en");
    expect(html).toContain("automated notification from RemitMortgage");
    expect(html).toContain("AstronLabs. All rights reserved.");
  });

  it("renders Spanish footer for locale=es", () => {
    const html = getBrandedHtml("Test", "<p>cuerpo</p>", "es");
    expect(html).toContain("notificación automática");
    expect(html).toContain("Todos los derechos reservados");
  });

  it("renders French footer for locale=fr", () => {
    const html = getBrandedHtml("Test", "<p>corps</p>", "fr");
    expect(html).toContain("notification automatique");
    expect(html).toContain("Tous droits réservés");
  });

  it("renders Chinese brand name for locale=zh", () => {
    const html = getBrandedHtml("Test", "<p>内容</p>", "zh");
    expect(html).toContain("AstronLabs | RemitMortgage");
    expect(html).toContain("保留所有权利");
  });

  it("falls back to English footer for unsupported locale", () => {
    const html = getBrandedHtml("Test", "<p>body</p>", "de");
    expect(html).toContain("automated notification from RemitMortgage");
  });
});

// ── Suite 6: email template functions with locale param ───────────────────────
describe("sendDepositReceipt locale", () => {
  let spy: jest.SpyInstance;
  beforeAll(() => {
    spy = jest.spyOn(transporter, "sendMail").mockResolvedValue({ messageId: "m" } as never);
  });
  afterAll(() => spy.mockRestore());
  beforeEach(() => spy.mockClear());

  it("English: subject and heading in English", async () => {
    await sendDepositReceipt("a@b.com", "100", "0xabc", "en");
    const { subject, html } = spy.mock.calls[0][0] as { subject: string; html: string };
    expect(subject).toContain("Deposit Receipt");
    expect(html).toContain("Deposit Confirmed");
    expect(html).toContain("100 USDC");
  });

  it("Spanish: subject and heading in Spanish", async () => {
    await sendDepositReceipt("a@b.com", "200", "0xdef", "es");
    const { subject, html } = spy.mock.calls[0][0] as { subject: string; html: string };
    expect(subject).toContain("Depósito");
    expect(html).toContain("Depósito Confirmado");
    expect(html).toContain("200 USDC");
  });

  it("Portuguese: subject and heading in Portuguese", async () => {
    await sendDepositReceipt("a@b.com", "300", "0xghi", "pt");
    const { subject, html } = spy.mock.calls[0][0] as { subject: string; html: string };
    expect(subject).toContain("Depósito");
    expect(html).toContain("Depósito Confirmado");
  });

  it("unsupported locale falls back to English", async () => {
    await sendDepositReceipt("a@b.com", "100", "0xabc", "sw");
    const { subject } = spy.mock.calls[0][0] as { subject: string };
    expect(subject).toContain("Deposit Receipt");
  });
});

describe("sendRepaymentReminder locale", () => {
  let spy: jest.SpyInstance;
  beforeAll(() => {
    spy = jest.spyOn(transporter, "sendMail").mockResolvedValue({ messageId: "m" } as never);
  });
  afterAll(() => spy.mockRestore());
  beforeEach(() => spy.mockClear());

  it("English reminder", async () => {
    await sendRepaymentReminder("a@b.com", "500", "2026-07-01T00:00:00Z", "en");
    const { html } = spy.mock.calls[0][0] as { html: string };
    expect(html).toContain("Repayment Reminder");
    expect(html).toContain("500 USDC");
    expect(html).toContain("Make Repayment Now");
  });

  it("French reminder", async () => {
    await sendRepaymentReminder("a@b.com", "500", "2026-07-01T00:00:00Z", "fr");
    const { subject, html } = spy.mock.calls[0][0] as { subject: string; html: string };
    expect(subject).toContain("Remboursement");
    expect(html).toContain("Rappel de Remboursement");
    expect(html).toContain("Effectuer le Remboursement");
  });

  it("Chinese reminder", async () => {
    await sendRepaymentReminder("a@b.com", "500", "2026-07-01T00:00:00Z", "zh");
    const { html } = spy.mock.calls[0][0] as { html: string };
    expect(html).toContain("还款提醒");
    expect(html).toContain("立即还款");
  });
});

describe("sendLoanStatusUpdate locale", () => {
  let spy: jest.SpyInstance;
  beforeAll(() => {
    spy = jest.spyOn(transporter, "sendMail").mockResolvedValue({ messageId: "m" } as never);
  });
  afterAll(() => spy.mockRestore());
  beforeEach(() => spy.mockClear());

  it("English loan status email includes status variable", async () => {
    await sendLoanStatusUpdate("a@b.com", "loan-1", "Approved", "en");
    const { subject, html } = spy.mock.calls[0][0] as { subject: string; html: string };
    expect(subject).toContain("Approved");
    expect(html).toContain("Approved");
    expect(html).toContain("loan-1");
  });

  it("Spanish loan status update", async () => {
    await sendLoanStatusUpdate("a@b.com", "loan-2", "Aprobado", "es");
    const { html } = spy.mock.calls[0][0] as { html: string };
    expect(html).toContain("solicitud de préstamo");
    expect(html).toContain("Aprobado");
  });

  it("no locale falls back to English", async () => {
    await sendLoanStatusUpdate("a@b.com", "loan-3", "Pending");
    const { subject } = spy.mock.calls[0][0] as { subject: string };
    expect(subject).toContain("Loan Application Status Update");
  });
});

// ── Suite 7: CI coverage validation ──────────────────────────────────────────
// Ensures every supported locale has every key — blocks future partial translations.
describe("Translation coverage validation (CI gate)", () => {
  const englishKeys = Object.keys(emailTranslations.en) as Array<keyof EmailTranslationCatalogue>;

  for (const locale of SUPPORTED_LOCALES) {
    it(`locale=${locale} has all required translation keys`, () => {
      const catalogue = emailTranslations[locale];
      const missingKeys = englishKeys.filter(
        (k) => catalogue[k] === undefined || catalogue[k] === null
      );
      expect(missingKeys).toHaveLength(0);
    });

    it(`locale=${locale} has no empty string values`, () => {
      const catalogue = emailTranslations[locale];
      const emptyKeys = englishKeys.filter((k) => catalogue[k] === "");
      expect(emptyKeys).toHaveLength(0);
    });
  }

  it("SUPPORTED_LOCALES matches emailTranslations keys", () => {
    const translationLocales = Object.keys(emailTranslations).sort();
    const supportedSorted = [...SUPPORTED_LOCALES].sort();
    expect(translationLocales).toEqual(supportedSorted);
  });
});

// ── Suite 8: repaymentAudit uses preferredLocale ──────────────────────────────
jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: { findMany: jest.fn(), update: jest.fn() },
    applicant: { findUnique: jest.fn() },
  },
}));
jest.mock("../services/notification.js", () => ({
  queueNotification: jest.fn(),
}));

import { runRepaymentAudit } from "../jobs/repaymentAudit.js";
import { prisma } from "../services/db.js";
import { queueNotification } from "../services/notification.js";

describe("repaymentAudit uses applicant preferredLocale", () => {
  beforeEach(() => jest.clearAllMocks());

  it("sends Spanish grace-period message to es-locale applicant", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-es",
        applicantId: "app-es",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 0,
        lateFeeBalance: 0,
      },
    ]);
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue({
      id: "app-es",
      stellarAddress: "GESTEST",
      preferredLocale: "es",
    });

    await runRepaymentAudit();

    const calls = (queueNotification as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const body: string = calls[0][2];
    expect(body).toContain("período de gracia");
    expect(body).not.toContain("grace period");
  });

  it("sends French defaulted message to fr-locale applicant", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-fr",
        applicantId: "app-fr",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday,
        missedPayments: 2,
        lateFeeBalance: 100,
      },
    ]);
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue({
      id: "app-fr",
      stellarAddress: "GFRTEST",
      preferredLocale: "fr",
    });

    await runRepaymentAudit();

    const calls = (queueNotification as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const body: string = calls[0][2];
    expect(body).toContain("défaut");
    expect(body).not.toContain("defaulted");
  });

  it("sends English message when preferredLocale is null", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-null",
        applicantId: "app-null",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 0,
        lateFeeBalance: 0,
      },
    ]);
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue({
      id: "app-null",
      stellarAddress: "GNULLTEST",
      preferredLocale: null,
    });

    await runRepaymentAudit();

    const calls = (queueNotification as jest.Mock).mock.calls;
    const body: string = calls[0][2];
    expect(body).toContain("grace period");
  });

  it("sends English message when preferredLocale is unsupported 'de'", async () => {
    const yesterday = new Date(Date.now() - 86_400_000);
    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-de",
        applicantId: "app-de",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 0,
        lateFeeBalance: 0,
      },
    ]);
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue({
      id: "app-de",
      stellarAddress: "GDETEST",
      preferredLocale: "de",
    });

    await runRepaymentAudit();

    const calls = (queueNotification as jest.Mock).mock.calls;
    const body: string = calls[0][2];
    expect(body).toContain("grace period");
  });
});
