// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

const fr = {
  "email.deposit_receipt.subject": "Reçu de Dépôt - RemitMortgage",
  "email.deposit_receipt.title": "Dépôt Confirmé",
  "email.deposit_receipt.body": "Nous avons reçu avec succès votre dépôt de <strong>{amount} USDC</strong>. Votre progression de remise a été mise à jour en conséquence.",
  "email.deposit_receipt.amount_label": "Montant",
  "email.deposit_receipt.tx_hash_label": "Hash de Transaction",
  "email.deposit_receipt.date_label": "Date",
  "email.deposit_receipt.footer": "Votre dépôt sera automatiquement traité dans votre compte de dépôt hypothécaire.",

  "email.repayment_reminder.subject": "Rappel de Remboursement - RemitMortgage",
  "email.repayment_reminder.title": "Rappel de Remboursement",
  "email.repayment_reminder.body": "Ceci est un rappel qu'un remboursement à venir est programmé pour votre prêt.",
  "email.repayment_reminder.amount_due_label": "Montant Dû",
  "email.repayment_reminder.due_date_label": "Date d'Échéance",
  "email.repayment_reminder.footer": "Veuillez vous assurer que des fonds suffisants sont disponibles dans votre portefeuille ou compte lié avant la date d'échéance pour éviter les pénalités de période de grâce.",
  "email.repayment_reminder.cta": "Effectuer le Remboursement Maintenant",

  "email.loan_status.subject": "Mise à Jour du Statut de Demande de Prêt : {status}",
  "email.loan_status.title": "Mise à Jour du Statut du Prêt",
  "email.loan_status.body": "Votre demande de prêt a été mise à jour au statut : <strong>{status}</strong>.",
  "email.loan_status.loan_id_label": "ID de Demande de Prêt",
  "email.loan_status.new_status_label": "Nouveau Statut",
  "email.loan_status.updated_at_label": "Mis à Jour Le",
  "email.loan_status.footer": "Connectez-vous au tableau de bord pour voir plus de détails sur votre demande.",

  "email.lockout.subject": "Alerte de Sécurité : Compte Verrouillé - RemitMortgage",
  "email.lockout.title": "Alerte de Sécurité : Compte Temporairement Verrouillé",
  "email.lockout.body": "Plusieurs tentatives de connexion échouées consécutives ont été détectées sur votre compte RemitMortgage.",
  "email.lockout.locked_message": "Pour protéger vos enregistrements financiers et vos actifs contre les accès non autorisés, votre compte a été temporairement verrouillé pour <strong>{lockoutMinutes} minute(s)</strong>.",
  "email.lockout.duration_label": "Durée du Verrouillage",
  "email.lockout.ip_label": "Adresse IP d'Origine",
  "email.lockout.timestamp_label": "Horodatage",
  "email.lockout.footer": "Si ce n'était pas vous, quelqu'un essaie peut-être de deviner votre mot de passe. Nous vous recommandons vivement de réinitialiser votre mot de passe immédiatement après l'expiration de la période de verrouillage.",
  "email.lockout.cta": "Réinitialiser le Mot de Passe",

  "email.alert_deposit.subject": "Dépôt Reçu - RemitMortgage",
  "email.alert_deposit.title": "Dépôt Reçu",
  "email.alert_deposit.body": "Un dépôt de <strong>{amount} USDC</strong> a été enregistré en chaîne contre votre dépôt hypothécaire.",
  "email.alert_deposit.amount_label": "Montant",
  "email.alert_deposit.borrower_label": "Emprunteur",
  "email.alert_deposit.ledger_label": "Grand Livre",
  "email.alert_deposit.footer": "Aucune action requise. Votre calendrier de remise a été mis à jour automatiquement.",

  "email.alert_repay.subject": "Remboursement Enregistré - RemitMortgage",
  "email.alert_repay.title": "Remboursement Enregistré",
  "email.alert_repay.body": "Nous avons appliqué un remboursement de <strong>{amount} USDC</strong> à votre solde de prêt en cours.",
  "email.alert_repay.amount_label": "Montant",
  "email.alert_repay.borrower_label": "Emprunteur",
  "email.alert_repay.ledger_label": "Grand Livre",
  "email.alert_repay.footer": "Connectez-vous au tableau de bord pour consulter votre calendrier d'amortissement mis à jour.",

  "email.alert_milestone.subject": "Jalon Approuvé - RemitMortgage",
  "email.alert_milestone.title": "Jalon Approuvé",
  "email.alert_milestone.body": "Un jalon de construction sur votre projet a été approuvé et les fonds sont prêts à être libérés.",
  "email.alert_milestone.milestone_label": "Jalon",
  "email.alert_milestone.released_label": "Montant Libéré",
  "email.alert_milestone.borrower_label": "Emprunteur",
  "email.alert_milestone.ledger_label": "Grand Livre",
  "email.alert_milestone.footer": "Votre entrepreneur peut maintenant passer à la prochaine étape des travaux.",
} as const;

export default fr;
