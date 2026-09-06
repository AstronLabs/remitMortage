import { prisma } from "../services/db.js";
import { queueNotification } from "../services/notification.js";

// Hardcoded default late fee if not globally specified elsewhere
const DEFAULT_LATE_FEE = 50.00;
const GRACE_PERIOD_DAYS = 3;

/**
 * Runs a daily audit on all ACTIVE loans to process repayments,
 * manage grace periods, assess late fees, and handle defaults.
 */
export async function runRepaymentAudit() {
  console.log(`[RepaymentAudit] Starting audit job at ${new Date().toISOString()}`);

  try {
    const activeLoans = await prisma.loanApplication.findMany({
      where: {
        status: { in: ["Approved", "Disbursing", "Repaying"] },
        deletedAt: null,
      },
    });

    let processed = 0;
    let failures = 0;
    const now = new Date();

    for (const loan of activeLoans) {
      try {
        if (!loan.dueDate) {
          continue; // No payment scheduled yet
        }

        // 1. Check if Defaulted
        if (loan.missedPayments >= 3) {
          // Note: In theory this should have transitioned on the 3rd miss,
          // but just as a safeguard we process it here too.
          await handleDefault(loan.id, loan.applicantId, loan.guarantorAddress ?? null);
          processed++;
          continue;
        }

        // 2. Overdue without a Grace Period
        if (now > loan.dueDate && !loan.gracePeriodEndsAt) {
          await handleEnterGracePeriod(loan.id, loan.applicantId, loan.guarantorAddress ?? null);
          processed++;
          continue;
        }

        // 3. Grace Period Expired
        if (loan.gracePeriodEndsAt && now > loan.gracePeriodEndsAt) {
          await handleMissedPayment(
            loan.id,
            loan.applicantId,
            loan.missedPayments,
            loan.lateFeeBalance,
            loan.guarantorAddress ?? null
          );
          processed++;
          continue;
        }

      } catch (err) {
        console.error(`[RepaymentAudit] Error processing loan ${loan.id}:`, err);
        failures++;
      }
    }

    console.log(`[RepaymentAudit] Completed. Processed: ${processed}. Failures: ${failures}.`);
  } catch (err) {
    console.error("[RepaymentAudit] Critical failure during audit job:", err);
  }
}

async function handleEnterGracePeriod(
  loanId: string,
  applicantId: string,
  guarantorAddress: string | null
) {
  // Use UTC-safe arithmetic (see issue #529 fix)
  const gracePeriodEndsAt = new Date();
  gracePeriodEndsAt.setUTCDate(gracePeriodEndsAt.getUTCDate() + GRACE_PERIOD_DAYS);

  await prisma.loanApplication.update({
    where: { id: loanId },
    data: { gracePeriodEndsAt },
  });

  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  if (applicant) {
    await queueNotification(
      `${applicant.stellarAddress}@example.com`,
      "EMAIL",
      `Your loan payment is overdue. You have entered a ${GRACE_PERIOD_DAYS}-day grace period.`
    );
  }

  // Warn the guarantor so they are aware repayment is overdue.
  if (guarantorAddress) {
    await queueNotification(
      `${guarantorAddress}@example.com`,
      "EMAIL",
      `Notice: A loan you co-signed is overdue. The borrower has entered a ${GRACE_PERIOD_DAYS}-day grace period. ` +
      `If the borrower does not pay within this period, your guarantor liability may be invoked.`
    );
  }
}

async function handleMissedPayment(
  loanId: string,
  applicantId: string,
  currentMissedPayments: number,
  currentLateFee: number,
  guarantorAddress: string | null
) {
  const newMissedPayments = currentMissedPayments + 1;
  const newLateFee = currentLateFee + DEFAULT_LATE_FEE;

    if (newMissedPayments >= 3) {
    // Transition to default
    await prisma.loanApplication.update({
      where: { id: loanId },
      data: { missedPayments: newMissedPayments, lateFeeBalance: newLateFee, gracePeriodEndsAt: null, status: "DEFAULTED" },
    });

    const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
    if (applicant) {
      await queueNotification(
        `${applicant.stellarAddress}@example.com`,
        "EMAIL",
        `Critical: Your loan has defaulted due to 3 consecutive missed payments.`
      );
    }

    // Invoke guarantor liability
    await invokeGuarantorLiability(loanId, guarantorAddress);
  } else {
    // Just a missed payment — reschedule next due date
    const nextDueDate = new Date();
    nextDueDate.setUTCDate(nextDueDate.getUTCDate() + 30);

    await prisma.loanApplication.update({
      where: { id: loanId },
      data: {
        missedPayments: newMissedPayments,
        lateFeeBalance: newLateFee,
        gracePeriodEndsAt: null,
        dueDate: nextDueDate,
      },
    });

    const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
    if (applicant) {
      await queueNotification(
        `${applicant.stellarAddress}@example.com`,
        "EMAIL",
        `You have missed a loan payment. A late fee of $${DEFAULT_LATE_FEE} has been applied.`
      );
    }

    // Also warn the guarantor on each missed payment
    if (guarantorAddress) {
      await queueNotification(
        `${guarantorAddress}@example.com`,
        "EMAIL",
        `Notice: A loan you co-signed has a missed payment (missed ${newMissedPayments} of 3). ` +
        `A late fee of $${DEFAULT_LATE_FEE} has been applied to the borrower's account.`
      );
    }
  }
}

async function handleDefault(loanId: string, applicantId: string) {
  await prisma.loanApplication.update({ where: { id: loanId }, data: { status: "DEFAULTED", gracePeriodEndsAt: null } });
  
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  if (applicant) {
    await queueNotification(
      `${applicant.stellarAddress}@example.com`,
      "EMAIL",
      `Critical: Your loan has defaulted due to 3 consecutive missed payments.`
    );
  }

  // Invoke guarantor liability
  await invokeGuarantorLiability(loanId, guarantorAddress);
}

/**
 * Invokes guarantor liability when the primary borrower defaults.
 *
 * What this does (off-chain):
 *   1. Sends a formal liability notification to the guarantor.
 *
 * On-chain limitation — documented:
 *   The Soroban lending-pool contract's mark_default function calls
 *   seize_collateral on the borrower's escrow only.  The contract has no
 *   concept of a guarantor address and no entry point to seize a guarantor's
 *   escrow or invoke guarantor.require_auth() for liability transfer.
 *
 *   To fully implement on-chain guarantor liability the contract would need:
 *     • A guarantor: Option<Address> field in LoanRecord (added by a new
 *       request_loan_with_guarantor entry point).
 *     • A seize_guarantor_collateral invocation in mark_default that
 *       calls guarantor.require_auth() and seizes the guarantor's escrow
 *       when the borrower's escrow is insufficient to cover the loss.
 *
 *   Until the contract is upgraded, this function records the liability event
 *   via notification (the backend's existing notification queue) and logs it.
 *   This is the closest architecture-consistent solution available.
 */
async function invokeGuarantorLiability(
  loanId: string,
  guarantorAddress: string | null
): Promise<void> {
  if (!guarantorAddress) {
    return; // No guarantor — preserve existing default behavior exactly
  }

  // Off-chain liability invocation: formal notification to the guarantor.
  // Per the guarantor agreement, this notification constitutes the demand
  // for the guarantor to cover the outstanding debt.
  await queueNotification(
    `${guarantorAddress}@example.com`,
    "EMAIL",
    `GUARANTOR LIABILITY INVOKED: The primary borrower on loan ${loanId} has defaulted. ` +
    `As the co-signer/guarantor you are now liable for the outstanding debt. ` +
    `Please contact support immediately to arrange repayment.`
  );

  // Structured log for audit trail and future on-chain integration.
  console.log(
    `[RepaymentAudit] Guarantor liability invoked: loanId=${loanId} guarantor=${guarantorAddress}`
  );
}
