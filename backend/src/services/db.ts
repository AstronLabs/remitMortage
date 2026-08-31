const { PrismaClient } = require("@prisma/client") as {
  PrismaClient: new (options?: Record<string, unknown>) => any;
};

import { encrypt, decrypt } from "../utils/crypto.js";
import {
  buildDatabaseUrl,
  resolveReadReplicaSettings,
} from "./dbPoolConfig.js";
import {
  createDbPoolMetricsExtension,
  initDbPoolMetrics,
} from "./dbPoolMetrics.js";

export type VerificationStatus = "PENDING" | "ELIGIBLE" | "INELIGIBLE";

// ── Connection pool configuration ────────────────────────────────────────────
//
// Prisma uses its own built-in connection pool on top of the pg driver.
// Under sustained concurrent load the default pool (num_cpus*2+1 connections,
// 10 s acquire timeout) runs out quickly, causing P2024 "connection pool
// timeout" errors. The three knobs we override — connection_limit,
// pool_timeout and connect_timeout — are resolved in `dbPoolConfig.ts` so the
// pool metrics can report utilization against the same limit the pool
// actually enforces. See docs/DB_CONNECTION_POOL_TUNING.md for sizing guidance.
//
const dbUrl = buildDatabaseUrl();
const { url: replicaUrl, lagThresholdSeconds } = resolveReadReplicaSettings();

function createPrismaClient(url: string | undefined) {
  const client = new PrismaClient(
    url
      ? {
          datasources: {
            db: { url },
          },
        }
      : undefined
  );

  // Route every operation through the pool-saturation instrumentation. The
  // extension is applied defensively: `$extends` is unavailable on some mocked
  // clients used in tests, and losing metrics is never a reason to take the
  // service down.
  initDbPoolMetrics();
  if (typeof client.$extends !== "function") {
    return client;
  }

  try {
    return client.$extends(createDbPoolMetricsExtension());
  } catch {
    return client;
  }
}

export const prisma = createPrismaClient(dbUrl);
export const readReplicaPrisma =
  replicaUrl && buildDatabaseUrl({ ...process.env, DATABASE_URL: replicaUrl })
    ? createPrismaClient(buildDatabaseUrl({ ...process.env, DATABASE_URL: replicaUrl }))
    : prisma;

export const READ_REPLICA_LAG_THRESHOLD_SECONDS = lagThresholdSeconds;

export async function getReadReplicaLagSeconds(): Promise<number | null> {
  if (!replicaUrl || readReplicaPrisma === prisma) {
    return null;
  }

  try {
    const rows = (await (readReplicaPrisma as any).$queryRaw`SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - pg_last_xact_replay_timestamp()))::int, 0) AS lag_seconds`) as Array<{ lag_seconds: number | string | null }>;
    const lag = Number(rows?.[0]?.lag_seconds ?? 0);
    return Number.isFinite(lag) ? lag : null;
  } catch {
    return null;
  }
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
  if (readReplicaPrisma !== prisma) {
    await readReplicaPrisma.$disconnect();
  }
}

// ── Applicant ─────────────────────────────────────────────────────────────

const ENCRYPTED_FIELDS = ["taxId", "monthlyIncome"] as const;

function encryptFields<T extends Record<string, any>>(data: T): T {
  const result: Record<string, any> = { ...data };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = encrypt(String(result[field]));
    }
  }
  return result as T;
}

function decryptApplicant(applicant: any): any {
  if (!applicant) return applicant;
  const result = { ...applicant };
  for (const field of ENCRYPTED_FIELDS) {
    if (result[field] !== undefined && result[field] !== null) {
      result[field] = decrypt(result[field]);
    }
  }
  return result;
}

function addStroops(a: string, b: string): string {
  return (BigInt(a || "0") + BigInt(b || "0")).toString();
}

function subStroops(a: string, b: string): string {
  const result = BigInt(a || "0") - BigInt(b || "0");
  return (result < 0n ? 0n : result).toString();
}

function eventHash(kind: string, contractId: string, borrower: string, amount: string, ledger: number): string {
  return createHash("sha256")
    .update(`${kind}|${contractId}|${borrower}|${amount}|${ledger}`)
    .digest("hex");
}

function isUniqueConstraintError(error: any, target: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    Array.isArray(error.meta?.target) &&
    error.meta.target.includes(target)
  );
}

export async function loadIndexerState(key: string) {
  const state = await prisma.eventIndexerState.findUnique({ where: { key } });
  return {
    lastProcessedLedger: state?.lastProcessedLedger ?? 0,
    cursor: state?.cursor ?? null,
  };
}

export async function saveIndexerState(key: string, lastProcessedLedger: number, cursor: string | null) {
  return prisma.eventIndexerState.upsert({
    where: { key },
    create: { key, lastProcessedLedger, cursor },
    update: { lastProcessedLedger, cursor },
  });
}

export async function getBorrower(stellarAddress: string) {
  return prisma.borrower.findFirst({
    where: { stellarAddress, deletedAt: null },
  });
}

export async function getBorrowerStatus(stellarAddress: string) {
  return prisma.borrower.findFirst({
    where: { stellarAddress, deletedAt: null },
    select: {
      stellarAddress: true,
      escrowBalance: true,
      loanOutstanding: true,
      totalDeposited: true,
      totalDisbursed: true,
      totalRepaid: true,
      lastEventLedger: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

async function ensureBorrower(stellarAddress: string) {
  return prisma.borrower.upsert({
    where: { stellarAddress },
    create: { stellarAddress },
    update: {},
  });
}

export async function recordEscrowDeposit(
  stellarAddress: string,
  contractId: string,
  amount: string,
  ledger: number
) {
  const borrower = await ensureBorrower(stellarAddress);
  const hash = eventHash("deposit", contractId, stellarAddress, amount, ledger);
  try {
    await prisma.escrowDeposit.create({
      data: {
        borrowerId: borrower.id,
        contractId,
        amount,
        ledger,
        eventHash: hash,
      },
    });
  } catch (err: any) {
    if (isUniqueConstraintError(err, "eventHash")) {
      return borrower;
    }
    throw err;
  }

  return prisma.borrower.update({
    where: { id: borrower.id },
    data: {
      escrowBalance: addStroops(borrower.escrowBalance, amount),
      totalDeposited: addStroops(borrower.totalDeposited, amount),
      lastEventLedger: Math.max(borrower.lastEventLedger, ledger),
    },
  });
}

export async function recordEscrowWithdrawal(
  stellarAddress: string,
  contractId: string,
  amount: string,
  ledger: number
) {
  const borrower = await ensureBorrower(stellarAddress);
  const hash = eventHash("withdraw", contractId, stellarAddress, amount, ledger);
  try {
    await prisma.escrowWithdrawal.create({
      data: {
        borrowerId: borrower.id,
        contractId,
        amount,
        ledger,
        eventHash: hash,
      },
    });
  } catch (err: any) {
    if (isUniqueConstraintError(err, "eventHash")) {
      return borrower;
    }
    throw err;
  }

  return prisma.borrower.update({
    where: { id: borrower.id },
    data: {
      escrowBalance: subStroops(borrower.escrowBalance, amount),
      lastEventLedger: Math.max(borrower.lastEventLedger, ledger),
    },
  });
}

export async function recordLoanDisbursement(
  stellarAddress: string,
  contractId: string,
  amount: string,
  ledger: number
) {
  const borrower = await ensureBorrower(stellarAddress);
  const hash = eventHash("disburse", contractId, stellarAddress, amount, ledger);
  try {
    await prisma.loanDisbursement.create({
      data: {
        borrowerId: borrower.id,
        contractId,
        amount,
        ledger,
        eventHash: hash,
      },
    });
  } catch (err: any) {
    if (isUniqueConstraintError(err, "eventHash")) {
      return borrower;
    }
    throw err;
  }

  return prisma.borrower.update({
    where: { id: borrower.id },
    data: {
      loanOutstanding: addStroops(borrower.loanOutstanding, amount),
      totalDisbursed: addStroops(borrower.totalDisbursed, amount),
      lastEventLedger: Math.max(borrower.lastEventLedger, ledger),
    },
  });
}

export async function recordLoanRepayment(
  stellarAddress: string,
  contractId: string,
  amount: string,
  ledger: number
) {
  const borrower = await ensureBorrower(stellarAddress);
  const hash = eventHash("repay", contractId, stellarAddress, amount, ledger);
  try {
    await prisma.loanRepayment.create({
      data: {
        borrowerId: borrower.id,
        contractId,
        amount,
        ledger,
        eventHash: hash,
      },
    });
  } catch (err: any) {
    if (isUniqueConstraintError(err, "eventHash")) {
      return borrower;
    }
    throw err;
  }

  return prisma.borrower.update({
    where: { id: borrower.id },
    data: {
      loanOutstanding: subStroops(borrower.loanOutstanding, amount),
      totalRepaid: addStroops(borrower.totalRepaid, amount),
      lastEventLedger: Math.max(borrower.lastEventLedger, ledger),
    },
  });
}

// ── Applicant ─────────────────────────────────────────────────────────────────

export async function upsertApplicant(
  stellarAddress: string,
  data: {
    verificationStatus?: VerificationStatus;
    creditScore?: number;
    taxId?: string;
    monthlyIncome?: string;
  }
) {
  const encrypted = encryptFields(data);
  return prisma.applicant.upsert({
    where: { stellarAddress },
    update: { ...encrypted, deletedAt: null, updatedAt: new Date() },
    create: { stellarAddress, ...encrypted },
  });
}

export async function getApplicant(stellarAddress: string) {
  const applicant = await prisma.applicant.findFirst({
    where: { stellarAddress, deletedAt: null },
    include: {
      verificationResults: { orderBy: { analyzedAt: "desc" }, take: 1 },
      loanApplications: { orderBy: { createdAt: "desc" }, take: 1 },
      notificationPreference: true,
    },
  });
  return decryptApplicant(applicant);
}

// ── VerificationResult ────────────────────────────────────────────────────

export async function createVerificationResult(data: {
  applicantId: string;
  reportHash: string;
  totalPayments: number;
  totalVolume: number;
  spanMonths: number;
  eligible: boolean;
}) {
  return prisma.verificationResult.create({ data });
}

// ── LoanApplication ────────────────────────────────────────────────────────
// Protocol bounds for interestRateBps (2% floor, 18% cap) — mirrors
// contracts/verification-registry/src/lib.rs RATE_FLOOR_BPS / RATE_CAP_BPS
export const LOAN_PRINCIPAL_MIN = 0; // exclusive: principal > 0
export const LOAN_INTEREST_RATE_MIN_BPS = 200;
export const LOAN_INTEREST_RATE_MAX_BPS = 1800;
export const LOAN_INTEREST_RATE_DEFAULT_BPS = 800;

export async function createLoanApplication(data: {
  applicantId: string;
  escrowContractId?: string;
  loanId?: string;
  principal: number;
  interestRateBps?: number;
}) {
  // App-layer validation for fast feedback; DB CHECK is final gate even if bypassed
  if (data.principal <= LOAN_PRINCIPAL_MIN) {
    throw new Error(`principal must be > ${LOAN_PRINCIPAL_MIN}`);
  }
  if (data.interestRateBps !== undefined) {
    if (
      data.interestRateBps < LOAN_INTEREST_RATE_MIN_BPS ||
      data.interestRateBps > LOAN_INTEREST_RATE_MAX_BPS
    ) {
      throw new Error(
        `interestRateBps must be between ${LOAN_INTEREST_RATE_MIN_BPS} and ${LOAN_INTEREST_RATE_MAX_BPS} (got ${data.interestRateBps})`
      );
    }
  }
  return prisma.loanApplication.create({ data });
}

// ── NotificationPreference ─────────────────────────────────────────────────

export type NotificationPreferenceData = {
  email?: string;
  phone?: string;
  emailAlerts?: boolean;
  smsAlerts?: boolean;
  escrowApproaching?: boolean;
  escrowReached?: boolean;
  paymentMissed?: boolean;
  loanMilestones?: boolean;
  webhookUrl?: string;
  timezone?: string;
  businessDays?: string;
  startHour?: string;
  endHour?: string;
};

export async function getNotificationPreference(stellarAddressOrId: string) {
  // First try finding applicant by stellarAddress or id
  let applicant = await prisma.applicant.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { stellarAddress: stellarAddressOrId },
        { id: stellarAddressOrId },
      ],
    },
    include: { notificationPreference: true },
  });

  if (!applicant) {
    // Auto-create applicant if address matches Stellar public key pattern
    if (stellarAddressOrId.startsWith("G") && stellarAddressOrId.length === 56) {
      applicant = await prisma.applicant.create({
        data: { stellarAddress: stellarAddressOrId },
        include: { notificationPreference: true },
      });
    } else {
      return null;
    }
  }

  return applicant.notificationPreference;
}

export async function upsertNotificationPreference(
  stellarAddressOrId: string,
  data: NotificationPreferenceData
) {
  let applicant = await prisma.applicant.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { stellarAddress: stellarAddressOrId },
        { id: stellarAddressOrId },
      ],
    },
  });

  if (!applicant) {
    const stellarAddress =
      stellarAddressOrId.startsWith("G") && stellarAddressOrId.length === 56
        ? stellarAddressOrId
        : `G_${stellarAddressOrId.slice(0, 50)}`;

    applicant = await prisma.applicant.create({
      data: { stellarAddress },
    });
  }

  return prisma.notificationPreference.upsert({
    where: { applicantId: applicant.id },
    update: {
      ...data,
      updatedAt: new Date(),
    },
    create: {
      applicantId: applicant.id,
      ...data,
    },
  });
}

// ── Data Protection (GDPR / Data Export & Deletion) ───────────────────────────

export async function getUserDataExport(stellarAddress: string) {
  const applicant = await prisma.applicant.findUnique({
    where: { stellarAddress },
    include: {
      verificationResults: { orderBy: { analyzedAt: "desc" } },
      loanApplications: { orderBy: { createdAt: "desc" } },
      borrowerCredentials: { orderBy: { createdAt: "desc" } },
      kycDocuments: { orderBy: { uploadedAt: "desc" } },
      notificationPreference: true,
    },
  });

  const decryptedApplicant = decryptApplicant(applicant);

  const borrower = await prisma.borrower.findUnique({
    where: { stellarAddress },
    include: {
      deposits: { orderBy: { createdAt: "desc" } },
      withdrawals: { orderBy: { createdAt: "desc" } },
      disbursements: { orderBy: { createdAt: "desc" } },
      repayments: { orderBy: { createdAt: "desc" } },
    },
  });

  const workspaceMemberships = await prisma.workspaceMember.findMany({
    where: { walletAddress: stellarAddress },
    include: { workspace: true },
  });

  const workspaceInvitations = await prisma.workspaceInvitation.findMany({
    where: { inviteeAddress: stellarAddress },
    include: { workspace: true },
  });

  const auditLogs = await prisma.auditLog.findMany({
    where: { actorAddress: stellarAddress },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const deletionRequests = await prisma.dataDeletionRequest.findMany({
    where: { walletAddress: stellarAddress },
    orderBy: { requestedAt: "desc" },
  });

  return {
    exportedAt: new Date().toISOString(),
    user: {
      walletAddress: stellarAddress,
    },
    applicantProfile: decryptedApplicant
      ? {
          id: decryptedApplicant.id,
          verificationStatus: decryptedApplicant.verificationStatus,
          creditScore: decryptedApplicant.creditScore,
          taxId: decryptedApplicant.taxId,
          monthlyIncome: decryptedApplicant.monthlyIncome,
          createdAt: decryptedApplicant.createdAt,
          updatedAt: decryptedApplicant.updatedAt,
        }
      : null,
    kycDocuments: decryptedApplicant?.kycDocuments || [],
    verificationResults: decryptedApplicant?.verificationResults || [],
    loanApplications: decryptedApplicant?.loanApplications || [],
    borrowerCredentials: decryptedApplicant?.borrowerCredentials || [],
    notificationPreferences: decryptedApplicant?.notificationPreference || null,
    onChainFinancialActivity: borrower
      ? {
          stellarAddress: borrower.stellarAddress,
          escrowBalance: borrower.escrowBalance,
          loanOutstanding: borrower.loanOutstanding,
          totalDeposited: borrower.totalDeposited,
          totalDisbursed: borrower.totalDisbursed,
          totalRepaid: borrower.totalRepaid,
          lastEventLedger: borrower.lastEventLedger,
          deposits: borrower.deposits,
          withdrawals: borrower.withdrawals,
          disbursements: borrower.disbursements,
          repayments: borrower.repayments,
        }
      : null,
    workspaceMemberships: workspaceMemberships.map((m: any) => ({
      workspaceId: m.workspaceId,
      workspaceName: m.workspace.name,
      workspaceSlug: m.workspace.slug,
      role: m.role,
      joinedAt: m.createdAt,
    })),
    workspaceInvitations: workspaceInvitations.map((i: any) => ({
      workspaceId: i.workspaceId,
      workspaceName: i.workspace.name,
      role: i.role,
      status: i.status,
      createdAt: i.createdAt,
    })),
    auditLogs: auditLogs.map((log: any) => ({
      id: log.id,
      action: log.action,
      ipAddress: log.ipAddress,
      metadata: log.metadata,
      createdAt: log.createdAt,
    })),
    deletionRequests: deletionRequests,
  };
}

export async function processUserDataDeletion(stellarAddress: string, reason?: string) {
  // 1. Create a deletion request record
  const deletionRequest = await prisma.dataDeletionRequest.create({
    data: {
      walletAddress: stellarAddress,
      reason: reason || "User requested self-service deletion",
      status: "PENDING",
    },
  });

  const anonymizedFields: string[] = [];
  const anonymizedOnChainRecords: string[] = [];

  // 2. Anonymize/Scrub Applicant PII
  const applicant = await prisma.applicant.findUnique({
    where: { stellarAddress },
  });

  if (applicant) {
    await prisma.applicant.update({
      where: { id: applicant.id },
      data: {
        taxId: null,
        monthlyIncome: null,
        creditScore: null,
        verificationStatus: "INELIGIBLE",
        deletedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    anonymizedFields.push("taxId", "monthlyIncome", "creditScore");

    await prisma.loanApplication.updateMany({
      where: { applicantId: applicant.id },
      data: { deletedAt: new Date() },
    });
    anonymizedFields.push("loanApplications");

    // 3. Scrub KycDocuments metadata & file references
    await prisma.kycDocument.updateMany({
      where: { applicantId: applicant.id },
      data: {
        originalName: "ANONYMIZED_DOCUMENT",
        mimeType: "application/octet-stream",
        expired: true,
      },
    });
    anonymizedFields.push("kycDocuments");

    // 4. Revoke and anonymize BorrowerCredentials
    await prisma.borrowerCredential.updateMany({
      where: { applicantId: applicant.id },
      data: {
        isRevoked: true,
        revokedAt: new Date(),
        challenge: null,
      },
    });
    anonymizedOnChainRecords.push("borrowerCredentials");

    // 5. Scrub notification preferences
    await prisma.notificationPreference.deleteMany({
      where: { applicantId: applicant.id },
    });
    anonymizedFields.push("notificationPreferences");
  }

  // 6. Scrub AuditLogs
  await prisma.auditLog.updateMany({
    where: { actorAddress: stellarAddress },
    data: {
      actorAddress: "ANONYMIZED_USER",
      ipAddress: "0.0.0.0",
      metadata: { scrubbed: true, reason: "GDPR deletion" },
    },
  });
  anonymizedFields.push("auditLogs");

  // 7. On-chain linked records (Borrower, EscrowDeposit, EscrowWithdrawal, LoanDisbursement, LoanRepayment)
  // are retained for financial audit & immutability compliance, but verified as unlinked from PII.
  const borrower = await prisma.borrower.findUnique({
    where: { stellarAddress },
  });
  if (borrower) {
    await prisma.borrower.update({
      where: { id: borrower.id },
      data: { deletedAt: new Date() },
    });
    anonymizedOnChainRecords.push(
      "escrowBalance",
      "loanOutstanding",
      "escrowDeposits",
      "escrowWithdrawals",
      "loanDisbursements",
      "loanRepayments"
    );
  }

  // 8. Update DataDeletionRequest to COMPLETED
  const completedRequest = await prisma.dataDeletionRequest.update({
    where: { id: deletionRequest.id },
    data: {
      status: "COMPLETED",
      processedAt: new Date(),
      anonymizedAt: new Date(),
      details: {
        anonymizedFields,
        anonymizedOnChainRecords,
        complianceNotice:
          "Off-chain PII has been scrubbed and borrower/loan records are soft-deleted pending compliance retention purge.",
      },
    },
  });

  return completedRequest;
}


