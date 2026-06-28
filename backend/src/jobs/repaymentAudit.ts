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
        status: "ACTIVE",
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
          await handleDefault(loan.id, loan.applicantId);
          processed++;
          continue;
        }

        // 2. Overdue without a Grace Period
        if (now > loan.dueDate && !loan.gracePeriodEndsAt) {
          await handleEnterGracePeriod(loan.id, loan.applicantId);
          processed++;
          continue;
        }

        // 3. Grace Period Expired
        if (loan.gracePeriodEndsAt && now > loan.gracePeriodEndsAt) {
          await handleMissedPayment(loan.id, loan.applicantId, loan.missedPayments, loan.lateFeeBalance);
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

async function handleEnterGracePeriod(loanId: string, applicantId: string) {
  const gracePeriodEndsAt = new Date();
  gracePeriodEndsAt.setDate(gracePeriodEndsAt.getDate() + GRACE_PERIOD_DAYS);

  await prisma.loanApplication.update({
    where: { id: loanId },
    data: {
      gracePeriodEndsAt,
    },
  });

  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  if (applicant) {
    await queueNotification(
      `${applicant.stellarAddress}@example.com`,
      "EMAIL",
      `Your loan payment is overdue. You have entered a ${GRACE_PERIOD_DAYS}-day grace period.`
    );
  }
}

async function handleMissedPayment(loanId: string, applicantId: string, currentMissedPayments: number, currentLateFee: number) {
  const newMissedPayments = currentMissedPayments + 1;
  const newLateFee = currentLateFee + DEFAULT_LATE_FEE;

  if (newMissedPayments >= 3) {
    // Transition to default
    await prisma.loanApplication.update({
      where: { id: loanId },
      data: {
        missedPayments: newMissedPayments,
        lateFeeBalance: newLateFee,
        gracePeriodEndsAt: null, // Clear grace period
        status: "DEFAULTED",
      },
    });

    const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
    if (applicant) {
      await queueNotification(
        `${applicant.stellarAddress}@example.com`,
        "EMAIL",
        `Critical: Your loan has defaulted due to 3 consecutive missed payments.`
      );
    }
  } else {
    // Just a missed payment, set next due date to e.g., 30 days from now
    const nextDueDate = new Date();
    nextDueDate.setDate(nextDueDate.getDate() + 30);

    await prisma.loanApplication.update({
      where: { id: loanId },
      data: {
        missedPayments: newMissedPayments,
        lateFeeBalance: newLateFee,
        gracePeriodEndsAt: null, // Clear grace period
        dueDate: nextDueDate, // Re-schedule next payment
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
  }
}

async function handleDefault(loanId: string, applicantId: string) {
  await prisma.loanApplication.update({
    where: { id: loanId },
    data: {
      status: "DEFAULTED",
      gracePeriodEndsAt: null,
    },
  });
  
  const applicant = await prisma.applicant.findUnique({ where: { id: applicantId } });
  if (applicant) {
    await queueNotification(
      `${applicant.stellarAddress}@example.com`,
      "EMAIL",
      `Critical: Your loan has defaulted due to 3 consecutive missed payments.`
    );
  }
}
