// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Loan agreement endpoints (issue #921). Mounted under `/api/loan` behind
 * `authMiddleware`.
 *
 *   POST /:id/agreements                 reviewer (admin) generates from the approved terms
 *   GET  /:id/agreements                 borrower or reviewer lists agreement versions
 *   GET  /:id/agreements/:version/pdf    borrower or reviewer downloads one version
 */

import { Router, Response } from "express";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { requireLoanAdmin, requireLoanOwnership } from "../security/requireResourceOwnership.js";
import {
  defaultLoanAgreementStore,
  generateLoanAgreement,
  type StoredLoanAgreement,
} from "../services/loanAgreement.js";
import { logAudit } from "../services/audit.js";

export const loanAgreementRouter = Router();

const AGREEMENT_STATUSES = new Set(["Approved", "Disbursing", "Repaying"]);

function summary(a: StoredLoanAgreement) {
  return {
    loanId: a.loanId,
    agreementVersion: a.agreementVersion,
    templateVersion: a.templateVersion,
    loanVersion: a.loanVersion,
    documentHash: a.documentHash,
    generatedAt: a.generatedAt.toISOString(),
  };
}

loanAgreementRouter.post("/:id/agreements", async (req: AuthenticatedRequest, res: Response) => {
  const loan = await requireLoanAdmin(req, res, String(req.params.id));
  if (!loan) return;
  if (!AGREEMENT_STATUSES.has(loan.status)) {
    return res.status(409).json({
      error: "loan_not_approved",
      message: "Agreements can only be generated for approved loans.",
    });
  }

  const { agreement, created } = await generateLoanAgreement({
    loanId: loan.id,
    loanVersion: loan.version,
    borrowerAddress: loan.borrowerAddress,
    principal: loan.amount,
    currency: "USDC",
    interestRateBps: loan.interestRateBps ?? 800,
    loanType: loan.loanType,
    rateSheetVersionId: loan.rateSheetVersionId,
  });

  if (created) {
    await logAudit({
      action: "loan_agreement_generated",
      actorAddress: req.user?.walletAddress,
      metadata: summary(agreement),
    });
  }
  return res.status(created ? 201 : 200).json(summary(agreement));
});

loanAgreementRouter.get("/:id/agreements", async (req: AuthenticatedRequest, res: Response) => {
  const loan = await requireLoanOwnership(req, res, String(req.params.id));
  if (!loan) return;
  const agreements = await defaultLoanAgreementStore.list(loan.id);
  return res.json({ agreements: agreements.map(summary) });
});

loanAgreementRouter.get(
  "/:id/agreements/:version/pdf",
  async (req: AuthenticatedRequest, res: Response) => {
    const loan = await requireLoanOwnership(req, res, String(req.params.id));
    if (!loan) return;
    const version = Number(req.params.version);
    const agreement = (await defaultLoanAgreementStore.list(loan.id)).find(
      (a) => a.agreementVersion === version
    );
    if (!agreement) return res.status(404).json({ error: "not_found" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="loan-agreement-${loan.id}-v${agreement.agreementVersion}.pdf"`
    );
    res.setHeader("X-Document-Hash", agreement.documentHash);
    return res.send(agreement.pdf);
  }
);
