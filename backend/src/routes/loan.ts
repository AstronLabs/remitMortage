import { Router } from "express";
import { StrKey } from "@stellar/stellar-sdk";
import { validatePositiveNumber } from "../middleware/validate.js";
import {
  createApplication,
  getApplication,
  getApplicationsByBorrower,
  getPendingApplications,
  updateApplication,
  escrowTargetMetForAmount,
} from "../services/loanStore.js";
import { queueNotification } from "../services/notification.js";

export const loanRouter = Router();

// POST /api/loan/apply
loanRouter.post("/apply", validatePositiveNumber("amount"), async (req, res) => {
  try {
    const { borrowerAddress, amount } = req.body ?? {};

    if (!borrowerAddress) {
      return res.status(400).json({ error: "missing_field", field: "borrowerAddress", message: "borrowerAddress is required" });
    }

    try {
      StrKey.decodeEd25519PublicKey(borrowerAddress);
    } catch (err) {
      return res.status(400).json({ error: "invalid_address", field: "borrowerAddress", message: "Invalid Stellar G-address" });
    }

    const escrowOk = escrowTargetMetForAmount(amount);
    if (!escrowOk) {
      return res.status(400).json({ error: "escrow_target_not_met", message: "Escrow target not reached for borrower" });
    }

    const app = await createApplication(borrowerAddress, String(amount));
    return res.status(201).json(app);
  } catch (error) {
    console.error("Loan apply error:", error);
    return res.status(500).json({ error: "failed_to_create_application" });
  }
});

// GET /api/loan/borrower/:address
loanRouter.get("/borrower/:address", async (req, res) => {
  const { address } = req.params ?? {};
  try {
    StrKey.decodeEd25519PublicKey(address);
  } catch (err) {
    return res.status(400).json({ error: "invalid_address", field: "address", message: "Invalid Stellar G-address" });
  }
  const apps = await getApplicationsByBorrower(address);
  return res.json(apps);
});

// GET /api/loan/pending
loanRouter.get("/pending", async (req, res) => {
  const pending = await getPendingApplications();
  return res.json(pending);
});

// POST /api/loan/:id/approve
loanRouter.post("/:id/approve", async (req, res) => {
  const { id } = req.params;
  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

  if (app.status !== "Pending") {
    return res.status(400).json({ error: "invalid_state", message: "Application must be Pending to approve" });
  }

  try {
    const approved = await updateApplication(id, { status: "Approved" });

    console.log(`Simulating on-chain request_loan for application ${id}`);
    const disbursing = await updateApplication(id, { status: "Disbursing" });

    const email = req.body.email || `${app.borrowerAddress}@example.com`;
    const webhookUrl = req.body.webhookUrl || "https://partner-platform.com/webhooks";

    if (approved) {
      await queueNotification(
        email,
        "EMAIL",
        JSON.stringify({
          template: "loan_status_update",
          loanId: id,
          status: "Approved"
        })
      );

      await queueNotification(
        webhookUrl,
        "WEBHOOK",
        JSON.stringify({
          event: "loan.milestone_approved",
          loanId: id,
          borrowerAddress: approved.borrowerAddress,
          status: "Approved",
          timestamp: Date.now()
        })
      );
    }

    return res.json(disbursing);
  } catch (err) {
    console.error("Approve error:", err);
    return res.status(500).json({ error: "approve_failed" });
  }
});

// POST /api/loan/:id/reject
loanRouter.post("/:id/reject", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body ?? {};
  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

  if (app.status !== "Pending") {
    return res.status(400).json({ error: "invalid_state", message: "Application must be Pending to reject" });
  }

  const updated = await updateApplication(id, { status: "Rejected", reason: reason ?? "No reason provided" });
  return res.json(updated);
});

// GET /api/loan/:id
loanRouter.get("/:id", async (req, res) => {
  const { id } = req.params;
  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });
  return res.json(app);
});

// POST /api/loan/:id/trigger-payment-due
// Simulates a payment due date checker trigger, queuing email and webhook alerts.
loanRouter.post("/:id/trigger-payment-due", async (req, res) => {
  const { id } = req.params;
  const { email, webhookUrl, amount, dueDate } = req.body ?? {};

  const app = await getApplication(id);
  if (!app) return res.status(404).json({ error: "not_found" });

  const targetEmail = email || `${app.borrowerAddress}@example.com`;
  const targetWebhookUrl = webhookUrl || "https://partner-platform.com/webhooks";
  const targetAmount = amount || app.amount;
  const targetDueDate = dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    const emailNotif = await queueNotification(
      targetEmail,
      "EMAIL",
      JSON.stringify({
        template: "repayment_reminder",
        amount: targetAmount,
        dueDate: targetDueDate
      })
    );

    const webhookNotif = await queueNotification(
      targetWebhookUrl,
      "WEBHOOK",
      JSON.stringify({
        event: "loan.payment_due",
        loanId: id,
        borrowerAddress: app.borrowerAddress,
        amount: targetAmount,
        dueDate: targetDueDate,
        timestamp: Date.now()
      })
    );

    return res.json({
      message: "Payment due notifications triggered and queued.",
      emailNotificationId: emailNotif.id,
      webhookNotificationId: webhookNotif.id
    });
  } catch (error: any) {
    console.error("Trigger payment due error:", error);
    return res.status(500).json({ error: "failed_to_trigger_notifications", message: error.message });
  }
});
