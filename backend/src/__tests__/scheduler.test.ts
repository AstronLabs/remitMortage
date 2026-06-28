import { runRepaymentAudit } from "../jobs/repaymentAudit.js";
import { prisma } from "../services/db.js";
import { queueNotification } from "../services/notification.js";

jest.mock("../services/db.js", () => ({
  prisma: {
    loanApplication: {
      findMany: jest.fn(),
      update: jest.fn(),
    },
    applicant: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("../services/notification.js", () => ({
  queueNotification: jest.fn(),
}));

describe("Repayment Audit Scheduler", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock an applicant
    (prisma.applicant.findUnique as jest.Mock).mockResolvedValue({
      id: "applicant-1",
      stellarAddress: "GABCD",
    });
  });

  it("should enter grace period when payment is overdue and no grace period exists", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-1",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: null,
        missedPayments: 0,
        lateFeeBalance: 0,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-1" },
        data: expect.objectContaining({
          gracePeriodEndsAt: expect.any(Date),
        }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      "GABCD@example.com",
      "EMAIL",
      expect.stringContaining("grace period")
    );
  });

  it("should apply late fee and increment missed payments when grace period expires", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-2",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday, // Expired
        missedPayments: 1,
        lateFeeBalance: 50,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-2" },
        data: expect.objectContaining({
          missedPayments: 2,
          lateFeeBalance: 100,
          gracePeriodEndsAt: null,
          dueDate: expect.any(Date), // Next due date
        }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      "GABCD@example.com",
      "EMAIL",
      expect.stringContaining("late fee")
    );
  });

  it("should transition loan to DEFAULTED on 3rd consecutive missed payment", async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    (prisma.loanApplication.findMany as jest.Mock).mockResolvedValue([
      {
        id: "loan-3",
        applicantId: "applicant-1",
        status: "ACTIVE",
        dueDate: yesterday,
        gracePeriodEndsAt: yesterday, // Expired
        missedPayments: 2, // This will be the 3rd miss
        lateFeeBalance: 100,
      },
    ]);

    await runRepaymentAudit();

    expect(prisma.loanApplication.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "loan-3" },
        data: expect.objectContaining({
          missedPayments: 3,
          lateFeeBalance: 150,
          gracePeriodEndsAt: null,
          status: "DEFAULTED",
        }),
      })
    );

    expect(queueNotification).toHaveBeenCalledWith(
      "GABCD@example.com",
      "EMAIL",
      expect.stringContaining("defaulted")
    );
  });
});
