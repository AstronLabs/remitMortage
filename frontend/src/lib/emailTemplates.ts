// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT
//
// Frontend-side email template renderers used exclusively by the internal
// email preview tool. These mirror the backend's emailTemplates.ts but are
// self-contained — they carry their own i18n dictionaries and sample data so
// the preview page works without a running backend.
//
// Nothing here should ever be imported into production send paths.

// ── i18n ─────────────────────────────────────────────────────────────────────

export type PreviewLocale = "en" | "es" | "fr";

export const PREVIEW_LOCALES: readonly PreviewLocale[] = ["en", "es", "fr"];

const LOCALE_LABELS: Record<PreviewLocale, string> = {
  en: "English",
  es: "Español",
  fr: "Français",
};

export function localeLabel(l: PreviewLocale): string {
  return LOCALE_LABELS[l];
}

type Dict = Record<string, string>;

const TRANSLATIONS: Record<PreviewLocale, Dict> = {
  en: {
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
    "email.repayment_reminder.footer": "Please ensure sufficient funds are available before the due date to avoid penalties.",
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
    "email.lockout.locked_message": "Your account has been temporarily locked for <strong>{lockoutMinutes} minute(s)</strong>.",
    "email.lockout.duration_label": "Lockout Duration",
    "email.lockout.ip_label": "Originating IP Address",
    "email.lockout.timestamp_label": "Timestamp",
    "email.lockout.footer": "If this was not you, we strongly recommend resetting your password immediately.",
    "email.lockout.cta": "Reset Password",

    "email.alert_deposit.subject": "Deposit Received - RemitMortgage",
    "email.alert_deposit.title": "Deposit Received",
    "email.alert_deposit.body": "A deposit of <strong>{amount} USDC</strong> was recorded on-chain.",
    "email.alert_deposit.amount_label": "Amount",
    "email.alert_deposit.borrower_label": "Borrower",
    "email.alert_deposit.ledger_label": "Ledger",
    "email.alert_deposit.footer": "No action is required. Your remittance timeline has been updated automatically.",

    "email.alert_milestone.subject": "Milestone Approved - RemitMortgage",
    "email.alert_milestone.title": "Milestone Approved",
    "email.alert_milestone.body": "A construction milestone has been approved and funds are cleared for release.",
    "email.alert_milestone.milestone_label": "Milestone",
    "email.alert_milestone.released_label": "Released Amount",
    "email.alert_milestone.borrower_label": "Borrower",
    "email.alert_milestone.ledger_label": "Ledger",
    "email.alert_milestone.footer": "Your contractor can now proceed with the next stage of work.",
  },
  es: {
    "email.deposit_receipt.subject": "Recibo de Depósito - RemitMortgage",
    "email.deposit_receipt.title": "Depósito Confirmado",
    "email.deposit_receipt.body": "Recibimos con éxito su depósito de <strong>{amount} USDC</strong>. Su progreso de remesas ha sido actualizado.",
    "email.deposit_receipt.amount_label": "Monto",
    "email.deposit_receipt.tx_hash_label": "Hash de Transacción",
    "email.deposit_receipt.date_label": "Fecha",
    "email.deposit_receipt.footer": "Su depósito será procesado automáticamente en su cuenta de fideicomiso hipotecario.",

    "email.repayment_reminder.subject": "Recordatorio de Pago - RemitMortgage",
    "email.repayment_reminder.title": "Recordatorio de Pago",
    "email.repayment_reminder.body": "Este es un recordatorio de que se ha programado un pago próximo para su préstamo.",
    "email.repayment_reminder.amount_due_label": "Monto Adeudado",
    "email.repayment_reminder.due_date_label": "Fecha de Vencimiento",
    "email.repayment_reminder.footer": "Asegúrese de tener fondos suficientes antes de la fecha de vencimiento.",
    "email.repayment_reminder.cta": "Realizar Pago Ahora",

    "email.loan_status.subject": "Actualización de Estado del Préstamo: {status}",
    "email.loan_status.title": "Actualización de Estado del Préstamo",
    "email.loan_status.body": "Su solicitud de préstamo ha sido actualizada al estado: <strong>{status}</strong>.",
    "email.loan_status.loan_id_label": "ID de Solicitud",
    "email.loan_status.new_status_label": "Nuevo Estado",
    "email.loan_status.updated_at_label": "Actualizado El",
    "email.loan_status.footer": "Inicie sesión en el panel para ver más detalles sobre su solicitud.",

    "email.lockout.subject": "Alerta de Seguridad: Cuenta Bloqueada - RemitMortgage",
    "email.lockout.title": "Alerta de Seguridad: Cuenta Temporalmente Bloqueada",
    "email.lockout.body": "Se detectaron múltiples intentos de inicio de sesión fallidos en su cuenta de RemitMortgage.",
    "email.lockout.locked_message": "Su cuenta ha sido bloqueada temporalmente por <strong>{lockoutMinutes} minuto(s)</strong>.",
    "email.lockout.duration_label": "Duración del Bloqueo",
    "email.lockout.ip_label": "Dirección IP de Origen",
    "email.lockout.timestamp_label": "Marca de Tiempo",
    "email.lockout.footer": "Si no fue usted, le recomendamos restablecer su contraseña de inmediato.",
    "email.lockout.cta": "Restablecer Contraseña",

    "email.alert_deposit.subject": "Depósito Recibido - RemitMortgage",
    "email.alert_deposit.title": "Depósito Recibido",
    "email.alert_deposit.body": "Se registró un depósito de <strong>{amount} USDC</strong> en la cadena.",
    "email.alert_deposit.amount_label": "Monto",
    "email.alert_deposit.borrower_label": "Prestatario",
    "email.alert_deposit.ledger_label": "Libro Contable",
    "email.alert_deposit.footer": "No se requiere ninguna acción. Su cronograma de remesas se actualizó automáticamente.",

    "email.alert_milestone.subject": "Hito Aprobado - RemitMortgage",
    "email.alert_milestone.title": "Hito Aprobado",
    "email.alert_milestone.body": "Se ha aprobado un hito de construcción y los fondos están listos para su liberación.",
    "email.alert_milestone.milestone_label": "Hito",
    "email.alert_milestone.released_label": "Monto Liberado",
    "email.alert_milestone.borrower_label": "Prestatario",
    "email.alert_milestone.ledger_label": "Libro Contable",
    "email.alert_milestone.footer": "Su contratista puede proceder con la siguiente etapa del trabajo.",
  },
  fr: {
    "email.deposit_receipt.subject": "Reçu de Dépôt - RemitMortgage",
    "email.deposit_receipt.title": "Dépôt Confirmé",
    "email.deposit_receipt.body": "Nous avons bien reçu votre dépôt de <strong>{amount} USDC</strong>. Votre progression de transfert a été mise à jour.",
    "email.deposit_receipt.amount_label": "Montant",
    "email.deposit_receipt.tx_hash_label": "Hash de Transaction",
    "email.deposit_receipt.date_label": "Date",
    "email.deposit_receipt.footer": "Votre dépôt sera automatiquement traité dans votre compte de séquestre hypothécaire.",

    "email.repayment_reminder.subject": "Rappel de Remboursement - RemitMortgage",
    "email.repayment_reminder.title": "Rappel de Remboursement",
    "email.repayment_reminder.body": "Ceci est un rappel qu'un remboursement est prévu pour votre prêt.",
    "email.repayment_reminder.amount_due_label": "Montant Dû",
    "email.repayment_reminder.due_date_label": "Date d'Échéance",
    "email.repayment_reminder.footer": "Assurez-vous d'avoir des fonds suffisants avant la date d'échéance.",
    "email.repayment_reminder.cta": "Effectuer le Remboursement",

    "email.loan_status.subject": "Mise à Jour du Statut du Prêt : {status}",
    "email.loan_status.title": "Mise à Jour du Statut du Prêt",
    "email.loan_status.body": "Votre demande de prêt a été mise à jour avec le statut : <strong>{status}</strong>.",
    "email.loan_status.loan_id_label": "ID de Demande",
    "email.loan_status.new_status_label": "Nouveau Statut",
    "email.loan_status.updated_at_label": "Mis à Jour Le",
    "email.loan_status.footer": "Connectez-vous au tableau de bord pour voir plus de détails.",

    "email.lockout.subject": "Alerte Sécurité : Compte Verrouillé - RemitMortgage",
    "email.lockout.title": "Alerte Sécurité : Compte Temporairement Verrouillé",
    "email.lockout.body": "Plusieurs tentatives de connexion échouées ont été détectées sur votre compte RemitMortgage.",
    "email.lockout.locked_message": "Votre compte a été temporairement verrouillé pendant <strong>{lockoutMinutes} minute(s)</strong>.",
    "email.lockout.duration_label": "Durée du Verrouillage",
    "email.lockout.ip_label": "Adresse IP d'Origine",
    "email.lockout.timestamp_label": "Horodatage",
    "email.lockout.footer": "Si ce n'était pas vous, nous vous recommandons de réinitialiser votre mot de passe immédiatement.",
    "email.lockout.cta": "Réinitialiser le Mot de Passe",

    "email.alert_deposit.subject": "Dépôt Reçu - RemitMortgage",
    "email.alert_deposit.title": "Dépôt Reçu",
    "email.alert_deposit.body": "Un dépôt de <strong>{amount} USDC</strong> a été enregistré sur la chaîne.",
    "email.alert_deposit.amount_label": "Montant",
    "email.alert_deposit.borrower_label": "Emprunteur",
    "email.alert_deposit.ledger_label": "Registre",
    "email.alert_deposit.footer": "Aucune action n'est requise. Votre calendrier de remises a été mis à jour automatiquement.",

    "email.alert_milestone.subject": "Jalon Approuvé - RemitMortgage",
    "email.alert_milestone.title": "Jalon Approuvé",
    "email.alert_milestone.body": "Un jalon de construction a été approuvé et les fonds sont prêts pour être libérés.",
    "email.alert_milestone.milestone_label": "Jalon",
    "email.alert_milestone.released_label": "Montant Libéré",
    "email.alert_milestone.borrower_label": "Emprunteur",
    "email.alert_milestone.ledger_label": "Registre",
    "email.alert_milestone.footer": "Votre entrepreneur peut maintenant passer à la prochaine étape des travaux.",
  },
};

function t(locale: PreviewLocale, key: string, vars?: Record<string, string | number>): string {
  const dict = TRANSLATIONS[locale] ?? TRANSLATIONS.en;
  let value = dict[key] ?? TRANSLATIONS.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      value = value.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return value;
}

// ── Branded HTML wrapper (mirrors backend getBrandedHtml) ─────────────────────

function getBrandedHtml(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;background:#f8fafc;margin:0;padding:0;color:#334155}
      .container{max-width:600px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px -1px rgba(0,0,0,.1);border:1px solid #e2e8f0}
      .header{background:#0f172a;color:#fff;padding:32px 24px;text-align:center}
      .header h1{margin:0;font-size:24px;font-weight:700;letter-spacing:-.025em}
      .content{padding:32px 24px;line-height:1.6}
      .cta-button{display:inline-block;background:#3b82f6;color:#fff!important;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:600;margin-top:24px;text-align:center}
      .footer{background:#f1f5f9;padding:24px;text-align:center;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0}
      .details-table{width:100%;margin-top:20px;border-collapse:collapse}
      .details-table td{padding:12px;border-bottom:1px solid #f1f5f9}
      .details-label{font-weight:600;color:#475569;width:35%}
      .details-value{color:#0f172a}
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header"><h1>AstronLabs | RemitMortgage</h1></div>
      <div class="content">${bodyHtml}</div>
      <div class="footer">
        <p>This is an automated notification from RemitMortgage protocol.</p>
        <p>&copy; 2026 AstronLabs. All rights reserved.</p>
      </div>
    </div>
  </body>
</html>`;
}

// ── Template IDs ──────────────────────────────────────────────────────────────

export type TemplateId =
  | "deposit_receipt"
  | "repayment_reminder"
  | "loan_status"
  | "lockout"
  | "alert_deposit"
  | "alert_milestone";

export interface TemplateMetadata {
  id: TemplateId;
  label: string;
  description: string;
}

export const TEMPLATES: TemplateMetadata[] = [
  { id: "deposit_receipt",    label: "Deposit Receipt",         description: "Sent when an investor/borrower deposit is confirmed on-chain." },
  { id: "repayment_reminder", label: "Repayment Reminder",      description: "Sent before a scheduled loan repayment is due." },
  { id: "loan_status",        label: "Loan Status Update",      description: "Sent when a loan application status changes." },
  { id: "lockout",            label: "Account Lockout Alert",   description: "Sent when repeated failed logins lock a user account." },
  { id: "alert_deposit",      label: "Ledger Deposit Alert",    description: "Ops alert when a deposit is recorded on the ledger." },
  { id: "alert_milestone",    label: "Milestone Approved Alert",description: "Ops alert when a construction milestone is approved." },
];

// ── Sample data ───────────────────────────────────────────────────────────────

const SAMPLE = {
  amount:        "2,500",
  transactionId: "0xabc123def456abc123def456abc123def456abc123def456abc123def456abc1",
  dueDate:       "2026-11-15",
  loanId:        "LN-2026-00847",
  loanStatus:    "Approved",
  lockoutMinutes: 30,
  ipAddress:     "198.51.100.42",
  borrower:      "GABC...1234",
  ledger:        4829301,
  milestoneId:   "MS-FRAME-002",
} as const;

// ── Renderers ─────────────────────────────────────────────────────────────────

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderTemplate(id: TemplateId, locale: PreviewLocale): RenderedEmail {
  switch (id) {
    case "deposit_receipt": {
      const subject = t(locale, "email.deposit_receipt.subject");
      const body = `
        <h2>${t(locale, "email.deposit_receipt.title")}</h2>
        <p>${t(locale, "email.deposit_receipt.body", { amount: SAMPLE.amount })}</p>
        <table class="details-table">
          <tr>
            <td class="details-label">${t(locale, "email.deposit_receipt.amount_label")}</td>
            <td class="details-value">${SAMPLE.amount} USDC</td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.deposit_receipt.tx_hash_label")}</td>
            <td class="details-value"><code>${SAMPLE.transactionId}</code></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.deposit_receipt.date_label")}</td>
            <td class="details-value">Jan 1, 2026, 12:00:00 PM</td>
          </tr>
        </table>
        <p>${t(locale, "email.deposit_receipt.footer")}</p>`;
      return { subject, html: getBrandedHtml(subject, body) };
    }

    case "repayment_reminder": {
      const subject = t(locale, "email.repayment_reminder.subject");
      const body = `
        <h2>${t(locale, "email.repayment_reminder.title")}</h2>
        <p>${t(locale, "email.repayment_reminder.body")}</p>
        <table class="details-table">
          <tr>
            <td class="details-label">${t(locale, "email.repayment_reminder.amount_due_label")}</td>
            <td class="details-value"><strong>${SAMPLE.amount} USDC</strong></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.repayment_reminder.due_date_label")}</td>
            <td class="details-value">Nov 15, 2026</td>
          </tr>
        </table>
        <p>${t(locale, "email.repayment_reminder.footer")}</p>
        <a href="#" class="cta-button">${t(locale, "email.repayment_reminder.cta")}</a>`;
      return { subject, html: getBrandedHtml(subject, body) };
    }

    case "loan_status": {
      const subject = t(locale, "email.loan_status.subject", { status: SAMPLE.loanStatus });
      const body = `
        <h2>${t(locale, "email.loan_status.title")}</h2>
        <p>${t(locale, "email.loan_status.body", { status: SAMPLE.loanStatus })}</p>
        <table class="details-table">
          <tr>
            <td class="details-label">${t(locale, "email.loan_status.loan_id_label")}</td>
            <td class="details-value"><code>${SAMPLE.loanId}</code></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.loan_status.new_status_label")}</td>
            <td class="details-value"><span style="color:#3b82f6;font-weight:bold">${SAMPLE.loanStatus}</span></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.loan_status.updated_at_label")}</td>
            <td class="details-value">Jan 1, 2026, 12:00:00 PM</td>
          </tr>
        </table>
        <p>${t(locale, "email.loan_status.footer")}</p>`;
      return { subject, html: getBrandedHtml(subject, body) };
    }

    case "lockout": {
      const subject = t(locale, "email.lockout.subject");
      const body = `
        <h2 style="color:#ef4444">${t(locale, "email.lockout.title")}</h2>
        <p>${t(locale, "email.lockout.body")}</p>
        <p>${t(locale, "email.lockout.locked_message", { lockoutMinutes: SAMPLE.lockoutMinutes })}</p>
        <table class="details-table">
          <tr>
            <td class="details-label">${t(locale, "email.lockout.duration_label")}</td>
            <td class="details-value"><strong>${SAMPLE.lockoutMinutes} minute(s)</strong></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.lockout.ip_label")}</td>
            <td class="details-value"><code>${SAMPLE.ipAddress}</code></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.lockout.timestamp_label")}</td>
            <td class="details-value">Jan 1, 2026, 12:00:00 PM</td>
          </tr>
        </table>
        <p>${t(locale, "email.lockout.footer")}</p>
        <a href="#" class="cta-button" style="background:#ef4444">${t(locale, "email.lockout.cta")}</a>`;
      return { subject, html: getBrandedHtml(subject, body) };
    }

    case "alert_deposit": {
      const subject = t(locale, "email.alert_deposit.subject");
      const body = `
        <h2>${t(locale, "email.alert_deposit.title")}</h2>
        <p>${t(locale, "email.alert_deposit.body", { amount: SAMPLE.amount })}</p>
        <table class="details-table">
          <tr>
            <td class="details-label">${t(locale, "email.alert_deposit.amount_label")}</td>
            <td class="details-value">${SAMPLE.amount} USDC</td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.alert_deposit.borrower_label")}</td>
            <td class="details-value"><code>${SAMPLE.borrower}</code></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.alert_deposit.ledger_label")}</td>
            <td class="details-value">${SAMPLE.ledger}</td>
          </tr>
        </table>
        <p>${t(locale, "email.alert_deposit.footer")}</p>`;
      return { subject, html: getBrandedHtml(subject, body) };
    }

    case "alert_milestone": {
      const subject = t(locale, "email.alert_milestone.subject");
      const body = `
        <h2>${t(locale, "email.alert_milestone.title")}</h2>
        <p>${t(locale, "email.alert_milestone.body")}</p>
        <table class="details-table">
          <tr>
            <td class="details-label">${t(locale, "email.alert_milestone.milestone_label")}</td>
            <td class="details-value"><code>${SAMPLE.milestoneId}</code></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.alert_milestone.released_label")}</td>
            <td class="details-value">${SAMPLE.amount} USDC</td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.alert_milestone.borrower_label")}</td>
            <td class="details-value"><code>${SAMPLE.borrower}</code></td>
          </tr>
          <tr>
            <td class="details-label">${t(locale, "email.alert_milestone.ledger_label")}</td>
            <td class="details-value">${SAMPLE.ledger}</td>
          </tr>
        </table>
        <p>${t(locale, "email.alert_milestone.footer")}</p>`;
      return { subject, html: getBrandedHtml(subject, body) };
    }
  }
}
