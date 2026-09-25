// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const es = {
  "email.deposit_receipt.subject": "Recibo de Depósito - RemitMortgage",
  "email.deposit_receipt.title": "Depósito Confirmado",
  "email.deposit_receipt.body": "Recibimos exitosamente su depósito de <strong>{amount} USDC</strong>. Su progreso de remesa ha sido actualizado en consecuencia.",
  "email.deposit_receipt.amount_label": "Monto",
  "email.deposit_receipt.tx_hash_label": "Hash de Transacción",
  "email.deposit_receipt.date_label": "Fecha",
  "email.deposit_receipt.footer": "Su depósito será procesado automáticamente en su cuenta de depósito de hipoteca.",

  "email.repayment_reminder.subject": "Recordatorio de Pago - RemitMortgage",
  "email.repayment_reminder.title": "Recordatorio de Pago",
  "email.repayment_reminder.body": "Este es un recordatorio de que un pago próximo está programado para su préstamo.",
  "email.repayment_reminder.amount_due_label": "Monto Adeudado",
  "email.repayment_reminder.due_date_label": "Fecha de Vencimiento",
  "email.repayment_reminder.footer": "Por favor, asegúrese de tener fondos suficientes en su billetera o cuenta vinculada antes de la fecha de vencimiento para evitar penalidades de período de gracia.",
  "email.repayment_reminder.cta": "Realizar Pago Ahora",

  "email.loan_status.subject": "Actualización de Estado de Solicitud de Préstamo: {status}",
  "email.loan_status.title": "Actualización de Estado del Préstamo",
  "email.loan_status.body": "Su solicitud de préstamo ha sido actualizada al estado: <strong>{status}</strong>.",
  "email.loan_status.loan_id_label": "ID de Solicitud de Préstamo",
  "email.loan_status.new_status_label": "Nuevo Estado",
  "email.loan_status.updated_at_label": "Actualizado En",
  "email.loan_status.footer": "Inicie sesión en el panel de control para ver más detalles sobre su solicitud.",

  "email.lockout.subject": "Alerta de Seguridad: Cuenta Bloqueada - RemitMortgage",
  "email.lockout.title": "Alerta de Seguridad: Cuenta Temporalmente Bloqueada",
  "email.lockout.body": "Se detectaron múltiples intentos de inicio de sesión fallidos consecutivos en su cuenta de RemitMortgage.",
  "email.lockout.locked_message": "Para proteger sus registros financieros y activos de acceso no autorizado, su cuenta ha sido temporalmente bloqueada por <strong>{lockoutMinutes} minuto(s)</strong>.",
  "email.lockout.duration_label": "Duración del Bloqueo",
  "email.lockout.ip_label": "Dirección IP de Origen",
  "email.lockout.timestamp_label": "Marca de Tiempo",
  "email.lockout.footer": "Si esto no fue usted, alguien puede estar intentando adivinar su contraseña. Recomendamos encarecidamente restablecer su contraseña inmediatamente una vez que expire el período de bloqueo.",
  "email.lockout.cta": "Restablecer Contraseña",

  "email.alert_deposit.subject": "Depósito Recibido - RemitMortgage",
  "email.alert_deposit.title": "Depósito Recibido",
  "email.alert_deposit.body": "Un depósito de <strong>{amount} USDC</strong> fue registrado en cadena contra su depósito de hipoteca.",
  "email.alert_deposit.amount_label": "Monto",
  "email.alert_deposit.borrower_label": "Prestatario",
  "email.alert_deposit.ledger_label": "Libro Mayor",
  "email.alert_deposit.footer": "No se requiere acción. Su línea de tiempo de remesa ha sido actualizada automáticamente.",

  "email.alert_repay.subject": "Pago Registrado - RemitMortgage",
  "email.alert_repay.title": "Pago Registrado",
  "email.alert_repay.body": "Aplicamos un pago de <strong>{amount} USDC</strong> a su saldo de préstamo pendiente.",
  "email.alert_repay.amount_label": "Monto",
  "email.alert_repay.borrower_label": "Prestatario",
  "email.alert_repay.ledger_label": "Libro Mayor",
  "email.alert_repay.footer": "Inicie sesión en el panel de control para revisar su calendario de amortización actualizado.",

  "email.alert_milestone.subject": "Hito Aprobado - RemitMortgage",
  "email.alert_milestone.title": "Hito Aprobado",
  "email.alert_milestone.body": "Un hito de construcción en su proyecto ha sido aprobado y los fondos están listos para ser liberados.",
  "email.alert_milestone.milestone_label": "Hito",
  "email.alert_milestone.released_label": "Monto Liberado",
  "email.alert_milestone.borrower_label": "Prestatario",
  "email.alert_milestone.ledger_label": "Libro Mayor",
  "email.alert_milestone.footer": "Su contratista ahora puede proceder con la siguiente etapa del trabajo.",
} as const;

export default es;
