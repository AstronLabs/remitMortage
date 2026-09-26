/**
 * Email template translations for transactional notifications.
 *
 * Locale selection / fallback rules (applied by getEmailTranslator):
 *   1. Use the recipient's stored preferredLocale when it is in SUPPORTED_LOCALES.
 *   2. Fall back to "en" when the locale is missing, unsupported, or any
 *      individual translation key is absent.
 *   3. Never render raw translation keys — the "en" catalogue is always complete
 *      so the fallback chain is guaranteed to resolve.
 *
 * Supported locales: en, es, pt, fr, zh
 *
 * No frontend i18n infrastructure exists in this repo; this catalogue is
 * intentionally self-contained in the backend.
 */

export const SUPPORTED_LOCALES = ["en", "es", "pt", "fr", "zh"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Shape of one locale's email translation catalogue. */
export interface EmailTranslationCatalogue {
  // ── Shared ────────────────────────────────────────────────────────────────
  brand_name: string;
  automated_footer: string;
  copyright_footer: string;

  // ── Deposit receipt ───────────────────────────────────────────────────────
  deposit_subject: string;
  deposit_heading: string;
  deposit_body: string;          // {{amount}}
  deposit_label_amount: string;
  deposit_label_tx: string;
  deposit_label_date: string;
  deposit_footer_note: string;

  // ── Repayment reminder ────────────────────────────────────────────────────
  repayment_subject: string;
  repayment_heading: string;
  repayment_body: string;
  repayment_label_amount: string;
  repayment_label_due: string;
  repayment_warning: string;
  repayment_cta: string;

  // ── Loan status update ────────────────────────────────────────────────────
  loan_status_subject: string;   // {{status}}
  loan_status_heading: string;
  loan_status_body: string;      // {{status}}
  loan_status_label_id: string;
  loan_status_label_status: string;
  loan_status_label_updated: string;
  loan_status_footer_note: string;

  // ── Repayment audit plain-text messages ───────────────────────────────────
  grace_period_body: string;     // {{days}}
  missed_payment_body: string;   // {{fee}}
  defaulted_body: string;

  // ── Guarantor notifications ───────────────────────────────────────────────
  guarantor_grace_period_body: string;  // {{days}}
  guarantor_missed_payment_body: string; // {{missed}}, {{max}}, {{fee}}
  guarantor_liability_subject: string;
  guarantor_liability_body: string;     // {{loanId}}
}

type TranslationMap = Record<SupportedLocale, EmailTranslationCatalogue>;

export const emailTranslations: TranslationMap = {
  // ── English (canonical — must be complete) ────────────────────────────────
  en: {
    brand_name: "AstronLabs | RemitMortgage",
    automated_footer: "This is an automated notification from RemitMortgage protocol.",
    copyright_footer: "AstronLabs. All rights reserved.",

    deposit_subject: "Deposit Receipt - RemitMortgage",
    deposit_heading: "Deposit Confirmed",
    deposit_body: "We successfully received your deposit of <strong>{{amount}} USDC</strong>. Your remittance progress has been updated accordingly.",
    deposit_label_amount: "Amount",
    deposit_label_tx: "Transaction Hash",
    deposit_label_date: "Date",
    deposit_footer_note: "Your deposit will be automatically processed into your mortgage escrow account.",

    repayment_subject: "Repayment Reminder - RemitMortgage",
    repayment_heading: "Repayment Reminder",
    repayment_body: "This is a reminder that an upcoming repayment is scheduled for your loan.",
    repayment_label_amount: "Amount Due",
    repayment_label_due: "Due Date",
    repayment_warning: "Please ensure sufficient funds are available in your wallet or linked account before the due date to avoid grace period penalties.",
    repayment_cta: "Make Repayment Now",

    loan_status_subject: "Loan Application Status Update: {{status}}",
    loan_status_heading: "Loan Status Update",
    loan_status_body: "Your loan application has been updated to status: <strong>{{status}}</strong>.",
    loan_status_label_id: "Loan Application ID",
    loan_status_label_status: "New Status",
    loan_status_label_updated: "Updated At",
    loan_status_footer_note: "Log in to the dashboard to view more details about your application.",

    grace_period_body: "Your loan payment is overdue. You have entered a {{days}}-day grace period.",
    missed_payment_body: "You have missed a loan payment. A late fee of ${{fee}} has been applied.",
    defaulted_body: "Critical: Your loan has defaulted due to 3 consecutive missed payments.",

    guarantor_grace_period_body: "Notice: A loan you co-signed is overdue. The borrower has entered a {{days}}-day grace period. If the borrower does not pay within this period, your guarantor liability may be invoked.",
    guarantor_missed_payment_body: "Notice: A loan you co-signed has a missed payment (missed {{missed}} of {{max}}). A late fee of ${{fee}} has been applied to the borrower's account.",
    guarantor_liability_subject: "GUARANTOR LIABILITY INVOKED",
    guarantor_liability_body: "GUARANTOR LIABILITY INVOKED: The primary borrower on loan {{loanId}} has defaulted. As the co-signer/guarantor you are now liable for the outstanding debt. Please contact support immediately to arrange repayment.",
  },

  // ── Spanish ───────────────────────────────────────────────────────────────
  es: {
    brand_name: "AstronLabs | RemitMortgage",
    automated_footer: "Esta es una notificación automática del protocolo RemitMortgage.",
    copyright_footer: "AstronLabs. Todos los derechos reservados.",

    deposit_subject: "Recibo de Depósito - RemitMortgage",
    deposit_heading: "Depósito Confirmado",
    deposit_body: "Hemos recibido exitosamente su depósito de <strong>{{amount}} USDC</strong>. Su progreso de remesas ha sido actualizado.",
    deposit_label_amount: "Monto",
    deposit_label_tx: "Hash de Transacción",
    deposit_label_date: "Fecha",
    deposit_footer_note: "Su depósito será procesado automáticamente en su cuenta de depósito hipotecario.",

    repayment_subject: "Recordatorio de Pago - RemitMortgage",
    repayment_heading: "Recordatorio de Pago",
    repayment_body: "Este es un recordatorio de que un próximo pago está programado para su préstamo.",
    repayment_label_amount: "Monto Adeudado",
    repayment_label_due: "Fecha de Vencimiento",
    repayment_warning: "Asegúrese de tener fondos suficientes en su billetera o cuenta vinculada antes de la fecha de vencimiento para evitar penalidades.",
    repayment_cta: "Realizar Pago Ahora",

    loan_status_subject: "Actualización de Estado del Préstamo: {{status}}",
    loan_status_heading: "Actualización de Préstamo",
    loan_status_body: "Su solicitud de préstamo ha sido actualizada al estado: <strong>{{status}}</strong>.",
    loan_status_label_id: "ID de Solicitud de Préstamo",
    loan_status_label_status: "Nuevo Estado",
    loan_status_label_updated: "Actualizado el",
    loan_status_footer_note: "Inicie sesión en el tablero para ver más detalles sobre su solicitud.",

    grace_period_body: "El pago de su préstamo está vencido. Ha entrado en un período de gracia de {{days}} días.",
    missed_payment_body: "Ha perdido un pago de préstamo. Se ha aplicado un cargo por mora de ${{fee}}.",
    defaulted_body: "Crítico: Su préstamo ha incurrido en incumplimiento debido a 3 pagos consecutivos perdidos.",

    guarantor_grace_period_body: "Aviso: Un préstamo que co-firmó está vencido. El prestatario ha entrado en un período de gracia de {{days}} días. Si el prestatario no paga dentro de este período, su responsabilidad como garante puede ser invocada.",
    guarantor_missed_payment_body: "Aviso: Un préstamo que co-firmó tiene un pago perdido (perdido {{missed}} de {{max}}). Se ha aplicado un cargo por mora de ${{fee}} a la cuenta del prestatario.",
    guarantor_liability_subject: "RESPONSABILIDAD DEL GARANTE INVOCADA",
    guarantor_liability_body: "RESPONSABILIDAD DEL GARANTE INVOCADA: El prestatario principal del préstamo {{loanId}} ha incurrido en incumplimiento. Como co-firmante/garante, ahora es responsable de la deuda pendiente. Por favor contacte al soporte de inmediato para acordar el reembolso.",
  },

  // ── Portuguese ────────────────────────────────────────────────────────────
  pt: {
    brand_name: "AstronLabs | RemitMortgage",
    automated_footer: "Esta é uma notificação automática do protocolo RemitMortgage.",
    copyright_footer: "AstronLabs. Todos os direitos reservados.",

    deposit_subject: "Recibo de Depósito - RemitMortgage",
    deposit_heading: "Depósito Confirmado",
    deposit_body: "Recebemos com sucesso o seu depósito de <strong>{{amount}} USDC</strong>. O seu progresso de remessa foi atualizado.",
    deposit_label_amount: "Valor",
    deposit_label_tx: "Hash da Transação",
    deposit_label_date: "Data",
    deposit_footer_note: "O seu depósito será processado automaticamente na sua conta de custódia hipotecária.",

    repayment_subject: "Lembrete de Pagamento - RemitMortgage",
    repayment_heading: "Lembrete de Pagamento",
    repayment_body: "Este é um lembrete de que um próximo pagamento está agendado para o seu empréstimo.",
    repayment_label_amount: "Valor Devido",
    repayment_label_due: "Data de Vencimento",
    repayment_warning: "Certifique-se de que há fundos suficientes na sua carteira ou conta vinculada antes da data de vencimento para evitar penalidades.",
    repayment_cta: "Fazer Pagamento Agora",

    loan_status_subject: "Atualização do Status do Empréstimo: {{status}}",
    loan_status_heading: "Atualização do Empréstimo",
    loan_status_body: "A sua solicitação de empréstimo foi atualizada para o status: <strong>{{status}}</strong>.",
    loan_status_label_id: "ID da Solicitação de Empréstimo",
    loan_status_label_status: "Novo Status",
    loan_status_label_updated: "Atualizado em",
    loan_status_footer_note: "Faça login no painel para ver mais detalhes sobre a sua solicitação.",

    grace_period_body: "O pagamento do seu empréstimo está vencido. Você entrou em um período de carência de {{days}} dias.",
    missed_payment_body: "Você perdeu um pagamento do empréstimo. Uma multa de ${{fee}} foi aplicada.",
    defaulted_body: "Crítico: Seu empréstimo entrou em inadimplência devido a 3 pagamentos consecutivos perdidos.",

    guarantor_grace_period_body: "Aviso: Um empréstimo que você co-assinou está vencido. O mutuário entrou em um período de carência de {{days}} dias. Se o mutuário não pagar dentro deste período, a sua responsabilidade como fiador poderá ser invocada.",
    guarantor_missed_payment_body: "Aviso: Um empréstimo que você co-assinou tem um pagamento perdido (perdido {{missed}} de {{max}}). Uma multa de ${{fee}} foi aplicada à conta do mutuário.",
    guarantor_liability_subject: "RESPONSABILIDADE DO FIADOR INVOCADA",
    guarantor_liability_body: "RESPONSABILIDADE DO FIADOR INVOCADA: O mutuário principal do empréstimo {{loanId}} entrou em inadimplência. Como co-signatário/fiador, você agora é responsável pela dívida pendente. Por favor entre em contato com o suporte imediatamente para combinar o reembolso.",
  },

  // ── French ────────────────────────────────────────────────────────────────
  fr: {
    brand_name: "AstronLabs | RemitMortgage",
    automated_footer: "Ceci est une notification automatique du protocole RemitMortgage.",
    copyright_footer: "AstronLabs. Tous droits réservés.",

    deposit_subject: "Reçu de Dépôt - RemitMortgage",
    deposit_heading: "Dépôt Confirmé",
    deposit_body: "Nous avons bien reçu votre dépôt de <strong>{{amount}} USDC</strong>. Votre progression de remise a été mise à jour en conséquence.",
    deposit_label_amount: "Montant",
    deposit_label_tx: "Hash de Transaction",
    deposit_label_date: "Date",
    deposit_footer_note: "Votre dépôt sera automatiquement traité sur votre compte séquestre hypothécaire.",

    repayment_subject: "Rappel de Remboursement - RemitMortgage",
    repayment_heading: "Rappel de Remboursement",
    repayment_body: "Ceci est un rappel qu'un prochain remboursement est prévu pour votre prêt.",
    repayment_label_amount: "Montant Dû",
    repayment_label_due: "Date d'Échéance",
    repayment_warning: "Veuillez vous assurer que des fonds suffisants sont disponibles dans votre portefeuille ou compte lié avant la date d'échéance pour éviter des pénalités.",
    repayment_cta: "Effectuer le Remboursement",

    loan_status_subject: "Mise à Jour du Statut du Prêt: {{status}}",
    loan_status_heading: "Mise à Jour du Prêt",
    loan_status_body: "Votre demande de prêt a été mise à jour au statut: <strong>{{status}}</strong>.",
    loan_status_label_id: "ID de Demande de Prêt",
    loan_status_label_status: "Nouveau Statut",
    loan_status_label_updated: "Mis à Jour le",
    loan_status_footer_note: "Connectez-vous au tableau de bord pour voir plus de détails sur votre demande.",

    grace_period_body: "Le paiement de votre prêt est en retard. Vous êtes entré dans une période de grâce de {{days}} jours.",
    missed_payment_body: "Vous avez manqué un paiement de prêt. Des frais de retard de ${{fee}} ont été appliqués.",
    defaulted_body: "Critique: Votre prêt est en défaut suite à 3 paiements consécutifs manqués.",

    guarantor_grace_period_body: "Avis: Un prêt que vous avez co-signé est en retard. L'emprunteur est entré dans une période de grâce de {{days}} jours. Si l'emprunteur ne paie pas dans ce délai, votre responsabilité de garant pourrait être invoquée.",
    guarantor_missed_payment_body: "Avis: Un prêt que vous avez co-signé a un paiement manqué (manqué {{missed}} sur {{max}}). Des frais de retard de ${{fee}} ont été appliqués au compte de l'emprunteur.",
    guarantor_liability_subject: "RESPONSABILITÉ DU GARANT INVOQUÉE",
    guarantor_liability_body: "RESPONSABILITÉ DU GARANT INVOQUÉE: L'emprunteur principal du prêt {{loanId}} est en défaut. En tant que co-signataire/garant, vous êtes maintenant responsable de la dette en cours. Veuillez contacter le support immédiatement pour organiser le remboursement.",
  },

  // ── Chinese (Simplified) ──────────────────────────────────────────────────
  zh: {
    brand_name: "AstronLabs | RemitMortgage",
    automated_footer: "这是来自RemitMortgage协议的自动通知。",
    copyright_footer: "AstronLabs。保留所有权利。",

    deposit_subject: "存款收据 - RemitMortgage",
    deposit_heading: "存款已确认",
    deposit_body: "我们已成功收到您的 <strong>{{amount}} USDC</strong> 存款。您的汇款进度已相应更新。",
    deposit_label_amount: "金额",
    deposit_label_tx: "交易哈希",
    deposit_label_date: "日期",
    deposit_footer_note: "您的存款将自动处理到您的抵押贷款托管账户中。",

    repayment_subject: "还款提醒 - RemitMortgage",
    repayment_heading: "还款提醒",
    repayment_body: "提醒您，您的贷款即将到期还款。",
    repayment_label_amount: "应还金额",
    repayment_label_due: "到期日",
    repayment_warning: "请确保在到期日前您的钱包或关联账户中有足够的资金，以避免宽限期罚款。",
    repayment_cta: "立即还款",

    loan_status_subject: "贷款申请状态更新：{{status}}",
    loan_status_heading: "贷款状态更新",
    loan_status_body: "您的贷款申请状态已更新为：<strong>{{status}}</strong>。",
    loan_status_label_id: "贷款申请编号",
    loan_status_label_status: "新状态",
    loan_status_label_updated: "更新时间",
    loan_status_footer_note: "登录控制面板查看您申请的更多详情。",

    grace_period_body: "您的贷款还款已逾期。您已进入{{days}}天宽限期。",
    missed_payment_body: "您错过了一次贷款还款。已收取${{fee}}滞纳金。",
    defaulted_body: "严重警告：由于连续3次未还款，您的贷款已违约。",

    guarantor_grace_period_body: "通知：您联署的贷款已逾期。借款人已进入{{days}}天宽限期。如借款人未在此期间还款，您的担保人责任可能被触发。",
    guarantor_missed_payment_body: "通知：您联署的贷款有一次未还款记录（共{{max}}次中已错过{{missed}}次）。借款人账户已被收取${{fee}}滞纳金。",
    guarantor_liability_subject: "担保人责任已触发",
    guarantor_liability_body: "担保人责任已触发：贷款{{loanId}}的主要借款人已违约。作为联署人/担保人，您现在对未偿债务负有责任。请立即联系客服安排还款。",
  },
};
