import {
  parsePrismaSchemaRelations,
  loadDocumentedRelations,
  DOCUMENTED_SCHEMA_RELATIONS,
  getDatabaseForeignKeyConstraints,
  crossCheckConstraints,
  scanOrphanedRows,
  runForeignKeyAudit,
  SchemaRelation,
  DatabaseForeignKeyConstraint,
  ForeignKeyAuditReport,
} from "../services/foreignKeyAudit.js";
import {
  runForeignKeyConstraintAuditJob,
  dispatchComplianceOpsAlert,
} from "../jobs/foreignKeyConstraintAudit.js";
import { sendEmail } from "../services/email.js";
import { sendWebhook } from "../services/webhook.js";
import { loadConfig } from "../config.js";
import logger from "../utils/logger.js";

// Mock email, webhook, config, and logger for unit test isolation
jest.mock("../services/email.js", () => ({
  sendEmail: jest.fn().mockResolvedValue(true),
  getBrandedHtml: jest.fn((title, content) => `<html><body><h1>${title}</h1>${content}</body></html>`),
}));

jest.mock("../services/webhook.js", () => ({
  sendWebhook: jest.fn().mockResolvedValue({ success: true, status: 200 }),
}));

jest.mock("../config.js", () => ({
  loadConfig: jest.fn(() => ({
    complianceAlertEmail: "compliance@remitmortgage.com",
    complianceSlackWebhookUrl: "https://hooks.slack.com/services/T00/B00/audit-webhook",
    opsFallbackAlertEmail: "ops@remitmortgage.com",
    opsSlackWebhookUrl: null,
    alertWebhookUrl: null,
  })),
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

describe("Foreign Key Constraint & Referential Integrity Audit Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // =========================================================================
  // 1. Schema Parsing & Documented Relations Registry
  // =========================================================================
  describe("parsePrismaSchemaRelations & loadDocumentedRelations", () => {
    it("parses relations with standard, cascade, and nullable configurations", () => {
      const samplePrismaSchema = `
        datasource db {
          provider = "postgresql"
          url      = env("DATABASE_URL")
        }

        model Applicant {
          id        String        @id @default(uuid())
          documents KycDocument[]
        }

        model KycDocument {
          id          String    @id @default(uuid())
          applicantId String
          applicant   Applicant @relation(fields: [applicantId], references: [id])
        }

        model Workspace {
          id      String            @id @default(uuid())
          members WorkspaceMember[]
        }

        model WorkspaceMember {
          id          String    @id @default(uuid())
          workspaceId String
          workspace   Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
        }

        model LoanComment {
          id        String       @id @default(uuid())
          parentId  String?
          parent    LoanComment? @relation("ThreadedComments", fields: [parentId], references: [id], onDelete: Cascade)
          replies   LoanComment[] @relation("ThreadedComments")
        }
      `;

      const parsed = parsePrismaSchemaRelations(samplePrismaSchema);

      expect(parsed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            childModel: "KycDocument",
            childTable: "KycDocument",
            childColumn: "applicantId",
            parentModel: "Applicant",
            parentTable: "Applicant",
            parentColumn: "id",
            isNullable: false,
          }),
          expect.objectContaining({
            childModel: "WorkspaceMember",
            childTable: "WorkspaceMember",
            childColumn: "workspaceId",
            parentModel: "Workspace",
            parentTable: "Workspace",
            parentColumn: "id",
            isNullable: false,
            onDelete: "Cascade",
          }),
          expect.objectContaining({
            childModel: "LoanComment",
            childTable: "LoanComment",
            childColumn: "parentId",
            parentModel: "LoanComment",
            parentTable: "LoanComment",
            parentColumn: "id",
            isNullable: true,
            onDelete: "Cascade",
          }),
        ])
      );

      // Verify that reverse array relations without foreign key fields are excluded
      expect(parsed.some((r) => r.childColumn === "" || r.parentColumn === "")).toBe(false);
      expect(parsed.length).toBe(3);
    });

    it("loads documented relations covering core RemitMortgage models", () => {
      const relations = loadDocumentedRelations();
      expect(relations.length).toBeGreaterThanOrEqual(10);

      const relationPairs = relations.map(
        (r) => `${r.childTable}.${r.childColumn} -> ${r.parentTable}.${r.parentColumn}`
      );

      expect(relationPairs).toContain("KycDocument.applicantId -> Applicant.id");
      expect(relationPairs).toContain("WorkspaceMember.workspaceId -> Workspace.id");
      expect(relationPairs).toContain("LoanApplication.applicantId -> Applicant.id");
      expect(relationPairs).toContain("LoanComment.loanApplicationId -> LoanApplication.id");
      expect(relationPairs).toContain("EscrowDeposit.borrowerId -> Borrower.id");
      expect(relationPairs).toContain("EscrowWithdrawal.borrowerId -> Borrower.id");
      expect(relationPairs).toContain("LoanDisbursement.borrowerId -> Borrower.id");
      expect(relationPairs).toContain("LoanRepayment.borrowerId -> Borrower.id");
    });
  });

  // =========================================================================
  // 2. Database Constraint Extraction
  // =========================================================================
  describe("getDatabaseForeignKeyConstraints", () => {
    it("queries information_schema and pg_constraint to extract active foreign keys", async () => {
      const mockQueryRaw = jest.fn().mockResolvedValue([
        {
          constraint_name: "KycDocument_applicantId_fkey",
          child_table: "KycDocument",
          child_column: "applicantId",
          parent_table: "Applicant",
          parent_column: "id",
          is_enforced: true,
        },
        {
          constraint_name: "LoanApplication_applicantId_fkey",
          child_table: "LoanApplication",
          child_column: "applicantId",
          parent_table: "Applicant",
          parent_column: "id",
          is_enforced: false,
        },
      ]);

      const mockPrisma = { $queryRaw: mockQueryRaw };
      const constraints = await getDatabaseForeignKeyConstraints(mockPrisma);

      expect(constraints).toHaveLength(2);
      expect(constraints[0]).toEqual({
        constraintName: "KycDocument_applicantId_fkey",
        childTable: "KycDocument",
        childColumn: "applicantId",
        parentTable: "Applicant",
        parentColumn: "id",
        isEnforced: true,
      });
      expect(constraints[1].isEnforced).toBe(false);
    });

    it("handles database query errors gracefully by returning an empty list", async () => {
      const mockPrisma = {
        $queryRaw: jest.fn().mockRejectedValue(new Error("Connection refused")),
      };
      const constraints = await getDatabaseForeignKeyConstraints(mockPrisma);
      expect(constraints).toEqual([]);
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Schema vs. Constraint Cross-Checking (Acceptance Criterion 2)
  // =========================================================================
  describe("crossCheckConstraints (AC #2: Flags relations lacking enforced database foreign keys)", () => {
    const testSchemaRelations: SchemaRelation[] = [
      {
        childModel: "KycDocument",
        childTable: "KycDocument",
        childColumn: "applicantId",
        parentModel: "Applicant",
        parentTable: "Applicant",
        parentColumn: "id",
        isNullable: false,
      },
      {
        childModel: "LoanApplication",
        childTable: "LoanApplication",
        childColumn: "applicantId",
        parentModel: "Applicant",
        parentTable: "Applicant",
        parentColumn: "id",
        isNullable: false,
      },
      {
        childModel: "EscrowDeposit",
        childTable: "EscrowDeposit",
        childColumn: "borrowerId",
        parentModel: "Borrower",
        parentTable: "Borrower",
        parentColumn: "id",
        isNullable: false,
      },
    ];

    it("returns zero findings when all schema relations have matching, enforced database constraints", () => {
      const dbConstraints: DatabaseForeignKeyConstraint[] = [
        {
          constraintName: "KycDocument_applicantId_fkey",
          childTable: "KycDocument",
          childColumn: "applicantId",
          parentTable: "Applicant",
          parentColumn: "id",
          isEnforced: true,
        },
        {
          constraintName: "LoanApplication_applicantId_fkey",
          childTable: "LoanApplication",
          childColumn: "applicantId",
          parentTable: "Applicant",
          parentColumn: "id",
          isEnforced: true,
        },
        {
          constraintName: "EscrowDeposit_borrowerId_fkey",
          childTable: "EscrowDeposit",
          childColumn: "borrowerId",
          parentTable: "Borrower",
          parentColumn: "id",
          isEnforced: true,
        },
      ];

      const findings = crossCheckConstraints(testSchemaRelations, dbConstraints);
      expect(findings).toEqual([]);
    });

    it("flags schema relations completely missing from database constraints as MISSING_IN_DB", () => {
      // Omit EscrowDeposit from dbConstraints
      const dbConstraints: DatabaseForeignKeyConstraint[] = [
        {
          constraintName: "KycDocument_applicantId_fkey",
          childTable: "KycDocument",
          childColumn: "applicantId",
          parentTable: "Applicant",
          parentColumn: "id",
          isEnforced: true,
        },
        {
          constraintName: "LoanApplication_applicantId_fkey",
          childTable: "LoanApplication",
          childColumn: "applicantId",
          parentTable: "Applicant",
          parentColumn: "id",
          isEnforced: true,
        },
      ];

      const findings = crossCheckConstraints(testSchemaRelations, dbConstraints);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        childTable: "EscrowDeposit",
        childColumn: "borrowerId",
        parentTable: "Borrower",
        parentColumn: "id",
        status: "MISSING_IN_DB",
        description: expect.stringContaining("has no enforced foreign key constraint"),
      });
    });

    it("flags database constraints with isEnforced: false as NOT_ENFORCED", () => {
      const dbConstraints: DatabaseForeignKeyConstraint[] = [
        {
          constraintName: "KycDocument_applicantId_fkey",
          childTable: "KycDocument",
          childColumn: "applicantId",
          parentTable: "Applicant",
          parentColumn: "id",
          isEnforced: true,
        },
        {
          constraintName: "LoanApplication_applicantId_fkey",
          childTable: "LoanApplication",
          childColumn: "applicantId",
          parentTable: "Applicant",
          parentColumn: "id",
          isEnforced: false, // NOT VALID / unenforced constraint
        },
        {
          constraintName: "EscrowDeposit_borrowerId_fkey",
          childTable: "EscrowDeposit",
          childColumn: "borrowerId",
          parentTable: "Borrower",
          parentColumn: "id",
          isEnforced: true,
        },
      ];

      const findings = crossCheckConstraints(testSchemaRelations, dbConstraints);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        childTable: "LoanApplication",
        childColumn: "applicantId",
        parentTable: "Applicant",
        parentColumn: "id",
        status: "NOT_ENFORCED",
        description: expect.stringContaining("marked NOT VALID (not enforced)"),
      });
    });

    it("performs case-insensitive table and column comparison", () => {
      const dbConstraints: DatabaseForeignKeyConstraint[] = [
        {
          constraintName: "kycdocument_applicantid_fkey",
          childTable: "kycdocument",
          childColumn: "applicantid",
          parentTable: "applicant",
          parentColumn: "id",
          isEnforced: true,
        },
      ];

      const findings = crossCheckConstraints([testSchemaRelations[0]], dbConstraints);
      expect(findings).toHaveLength(0);
    });
  });

  // =========================================================================
  // 4. Orphan Row Scanning (Acceptance Criterion 1)
  // =========================================================================
  describe("scanOrphanedRows (AC #1: Detects and reports orphaned rows)", () => {
    const testRelation: SchemaRelation = {
      childModel: "KycDocument",
      childTable: "KycDocument",
      childColumn: "applicantId",
      parentModel: "Applicant",
      parentTable: "Applicant",
      parentColumn: "id",
      isNullable: false,
    };

    it("detects orphaned child rows referencing deleted or non-existent parents (HARD_DELETE_ORPHAN)", async () => {
      const mockPrisma = {
        $queryRawUnsafe: jest.fn().mockImplementation((query: string) => {
          if (query.includes("COUNT(*)::int AS count") && query.includes("p.\"id\" IS NULL")) {
            return Promise.resolve([{ count: 2 }]);
          }
          if (query.includes("c.id::text AS id") && query.includes("p.\"id\" IS NULL")) {
            return Promise.resolve([{ id: "orphan-doc-1" }, { id: "orphan-doc-2" }]);
          }
          if (query.includes("WHERE p.\"deletedAt\" IS NOT NULL")) {
            return Promise.resolve([{ count: 0 }]);
          }
          return Promise.resolve([]);
        }),
      };

      const findings = await scanOrphanedRows(mockPrisma, [testRelation]);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        childTable: "KycDocument",
        childColumn: "applicantId",
        parentTable: "Applicant",
        parentColumn: "id",
        orphanCount: 2,
        sampleOrphanIds: ["orphan-doc-1", "orphan-doc-2"],
        type: "HARD_DELETE_ORPHAN",
        description: expect.stringContaining("Found 2 orphaned row(s)"),
      });
    });

    it("detects child rows referencing soft-deleted parents (SOFT_DELETE_ORPHAN)", async () => {
      const mockPrisma = {
        $queryRawUnsafe: jest.fn().mockImplementation((query: string) => {
          if (query.includes("p.\"id\" IS NULL")) {
            return Promise.resolve([{ count: 0 }]);
          }
          if (query.includes("WHERE p.\"deletedAt\" IS NOT NULL")) {
            if (query.includes("COUNT(*)::int AS count")) {
              return Promise.resolve([{ count: 1 }]);
            }
            if (query.includes("c.id::text AS id")) {
              return Promise.resolve([{ id: "soft-orphan-doc-3" }]);
            }
          }
          return Promise.resolve([]);
        }),
      };

      const findings = await scanOrphanedRows(mockPrisma, [testRelation]);

      expect(findings).toHaveLength(1);
      expect(findings[0]).toEqual({
        childTable: "KycDocument",
        childColumn: "applicantId",
        parentTable: "Applicant",
        parentColumn: "id",
        orphanCount: 1,
        sampleOrphanIds: ["soft-orphan-doc-3"],
        type: "SOFT_DELETE_ORPHAN",
        description: expect.stringContaining("referencing a soft-deleted parent"),
      });
    });

    it("returns zero findings when referential integrity is clean", async () => {
      const mockPrisma = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 0 }]),
      };

      const findings = await scanOrphanedRows(mockPrisma, [testRelation]);
      expect(findings).toHaveLength(0);
    });

    it("STRICT NON-DELETION GUARANTEE: Never invokes delete, deleteMany, or executeRaw queries", async () => {
      const mockPrisma: any = {
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 5 }]),
        $executeRaw: jest.fn(),
        $executeRawUnsafe: jest.fn(),
        kycDocument: {
          delete: jest.fn(),
          deleteMany: jest.fn(),
        },
        applicant: {
          delete: jest.fn(),
          deleteMany: jest.fn(),
        },
      };

      await scanOrphanedRows(mockPrisma, [testRelation]);

      // Assert only read queries occurred; no mutation methods called
      expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
      expect(mockPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
      expect(mockPrisma.kycDocument.delete).not.toHaveBeenCalled();
      expect(mockPrisma.kycDocument.deleteMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Full Audit Orchestrator (runForeignKeyAudit)
  // =========================================================================
  describe("runForeignKeyAudit", () => {
    it("reports status CLEAN when constraints match and no orphans exist", async () => {
      const mockPrisma = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            constraint_name: "KycDocument_applicantId_fkey",
            child_table: "KycDocument",
            child_column: "applicantId",
            parent_table: "Applicant",
            parent_column: "id",
            is_enforced: true,
          },
        ]),
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 0 }]),
      };

      const testRelation: SchemaRelation = {
        childModel: "KycDocument",
        childTable: "KycDocument",
        childColumn: "applicantId",
        parentModel: "Applicant",
        parentTable: "Applicant",
        parentColumn: "id",
        isNullable: false,
      };

      const report: ForeignKeyAuditReport = await runForeignKeyAudit({
        prismaClient: mockPrisma,
        customRelations: [testRelation],
      });

      expect(report.status).toBe("CLEAN");
      expect(report.totalOrphanCount).toBe(0);
      expect(report.totalMissingConstraintCount).toBe(0);
      expect(report.orphans).toEqual([]);
      expect(report.missingConstraints).toEqual([]);
      expect(report.summary).toContain("0 orphaned rows detected");
    });

    it("reports status ISSUES_DETECTED and aggregates all findings when integrity gaps exist", async () => {
      const mockPrisma = {
        // No constraints returned from database
        $queryRaw: jest.fn().mockResolvedValue([]),
        // Returns 3 orphans
        $queryRawUnsafe: jest.fn().mockImplementation((query: string) => {
          if (query.includes("COUNT(*)::int AS count") && query.includes("p.\"id\" IS NULL")) {
            return Promise.resolve([{ count: 3 }]);
          }
          if (query.includes("c.id::text AS id") && query.includes("p.\"id\" IS NULL")) {
            return Promise.resolve([{ id: "orphan-1" }, { id: "orphan-2" }, { id: "orphan-3" }]);
          }
          return Promise.resolve([{ count: 0 }]);
        }),
      };

      const testRelation: SchemaRelation = {
        childModel: "KycDocument",
        childTable: "KycDocument",
        childColumn: "applicantId",
        parentModel: "Applicant",
        parentTable: "Applicant",
        parentColumn: "id",
        isNullable: false,
      };

      const report = await runForeignKeyAudit({
        prismaClient: mockPrisma,
        customRelations: [testRelation],
      });

      expect(report.status).toBe("ISSUES_DETECTED");
      expect(report.totalOrphanCount).toBe(3);
      expect(report.totalMissingConstraintCount).toBe(1);
      expect(report.missingConstraints[0].status).toBe("MISSING_IN_DB");
      expect(report.orphans[0].sampleOrphanIds).toEqual(["orphan-1", "orphan-2", "orphan-3"]);
      expect(report.summary).toContain("detected 3 orphaned row(s)");
    });
  });

  // =========================================================================
  // 6. Scheduled Job & Compliance/Ops Alerting (runForeignKeyConstraintAuditJob)
  // =========================================================================
  describe("Scheduled Job & Compliance/Ops Alert Dispatching", () => {
    it("dispatches branded email and Slack alerts to compliance/ops when issues are found", async () => {
      const mockReport: ForeignKeyAuditReport = {
        timestamp: "2026-09-24T12:00:00.000Z",
        relationsCheckedCount: 16,
        existingConstraintsCount: 15,
        totalOrphanCount: 2,
        totalMissingConstraintCount: 1,
        status: "ISSUES_DETECTED",
        summary: "Audit detected 2 orphan(s) and 1 missing constraint(s)",
        missingConstraints: [
          {
            childTable: "EscrowDeposit",
            childColumn: "borrowerId",
            parentTable: "Borrower",
            parentColumn: "id",
            status: "MISSING_IN_DB",
            description: "No enforced foreign key",
          },
        ],
        orphans: [
          {
            childTable: "KycDocument",
            childColumn: "applicantId",
            parentTable: "Applicant",
            parentColumn: "id",
            orphanCount: 2,
            sampleOrphanIds: ["orphan-a", "orphan-b"],
            type: "HARD_DELETE_ORPHAN",
            description: "Found 2 orphaned row(s)",
          },
        ],
      };

      await dispatchComplianceOpsAlert(mockReport);

      // Verify Email Alert
      expect(sendEmail).toHaveBeenCalledWith(
        "compliance@remitmortgage.com",
        expect.stringContaining("Foreign Key Audit: 2 orphan(s), 1 missing constraint(s)"),
        expect.stringContaining("EscrowDeposit.borrowerId")
      );

      // Verify Slack Alert
      expect(sendWebhook).toHaveBeenCalledWith(
        "https://hooks.slack.com/services/T00/B00/audit-webhook",
        expect.objectContaining({
          text: expect.stringContaining("Human review required"),
          blocks: expect.arrayContaining([
            expect.objectContaining({
              type: "header",
            }),
          ]),
        })
      );
    });

    it("scheduled job runs end-to-end, notifies ops on issues, and performs no deletions", async () => {
      const mockPrisma: any = {
        $queryRaw: jest.fn().mockResolvedValue([]), // Missing constraint
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 0 }]),
        auditLog: {
          create: jest.fn().mockResolvedValue({ id: "audit-log-1" }),
        },
      };

      const testRelation: SchemaRelation = {
        childModel: "WorkspaceMember",
        childTable: "WorkspaceMember",
        childColumn: "workspaceId",
        parentModel: "Workspace",
        parentTable: "Workspace",
        parentColumn: "id",
        isNullable: false,
      };

      const report = await runForeignKeyConstraintAuditJob({
        prismaClient: mockPrisma,
        customRelations: [testRelation],
      });

      expect(report.status).toBe("ISSUES_DETECTED");
      expect(sendEmail).toHaveBeenCalled();
      expect(sendWebhook).toHaveBeenCalled();

      // Verify auditLog entry creation
      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "REFERENTIAL_INTEGRITY_AUDIT_FINDINGS",
          actorAddress: "system:scheduler",
        }),
      });
    });

    it("scheduled job stays silent when audit is completely CLEAN", async () => {
      const mockPrisma: any = {
        $queryRaw: jest.fn().mockResolvedValue([
          {
            constraint_name: "WorkspaceMember_workspaceId_fkey",
            child_table: "WorkspaceMember",
            child_column: "workspaceId",
            parent_table: "Workspace",
            parent_column: "id",
            is_enforced: true,
          },
        ]),
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ count: 0 }]),
      };

      const testRelation: SchemaRelation = {
        childModel: "WorkspaceMember",
        childTable: "WorkspaceMember",
        childColumn: "workspaceId",
        parentModel: "Workspace",
        parentTable: "Workspace",
        parentColumn: "id",
        isNullable: false,
      };

      const report = await runForeignKeyConstraintAuditJob({
        prismaClient: mockPrisma,
        customRelations: [testRelation],
      });

      expect(report.status).toBe("CLEAN");
      expect(sendEmail).not.toHaveBeenCalled();
      expect(sendWebhook).not.toHaveBeenCalled();
    });
  });
});

// ===========================================================================
// 7. Seeded Test Database Integration Suite (Requires active DATABASE_URL)
// =========================================================================
const hasDatabase = !!process.env.DATABASE_URL;
const describeDB = hasDatabase ? describe : describe.skip;

describeDB("Database Referential Integrity Audit - Seeded PostgreSQL Integration", () => {
  let realPrisma: any;
  let testApplicantId: string;
  let testLoanAppId: string;

  beforeAll(async () => {
    const db = await import("../services/db.js");
    realPrisma = db.prisma;
    await realPrisma.$connect();

    // Seed test parent records
    const applicant = await realPrisma.applicant.create({
      data: {
        stellarAddress: `GAUDIT${Date.now().toString().padStart(48, "0")}`,
        verificationStatus: "PENDING",
      },
    });
    testApplicantId = applicant.id;

    const loanApp = await realPrisma.loanApplication.create({
      data: {
        applicantId: testApplicantId,
        amount: "5000",
        purpose: "Audit Seeding Test",
        status: "Draft",
        principal: 5000,
        interestRateBps: 500,
      },
    });
    testLoanAppId = loanApp.id;
  });

  afterAll(async () => {
    if (realPrisma) {
      try {
        await realPrisma.loanComment.deleteMany({
          where: { loanApplicationId: testLoanAppId },
        });
        await realPrisma.loanApplication.deleteMany({
          where: { id: testLoanAppId },
        });
        await realPrisma.kycDocument.deleteMany({
          where: { applicantId: testApplicantId },
        });
        await realPrisma.applicant.deleteMany({
          where: { id: testApplicantId },
        });
        await realPrisma.$disconnect();
      } catch {
        // cleanup best effort
      }
    }
  });

  it("queries real information_schema constraints from the PostgreSQL instance", async () => {
    const constraints = await getDatabaseForeignKeyConstraints(realPrisma);
    expect(Array.isArray(constraints)).toBe(true);

    // If migrations are applied, verified foreign keys must be present
    if (constraints.length > 0) {
      expect(constraints[0]).toHaveProperty("constraintName");
      expect(constraints[0]).toHaveProperty("childTable");
      expect(constraints[0]).toHaveProperty("isEnforced");
    }
  });

  it("detects seeded orphaned row referencing a soft-deleted parent without deleting it", async () => {
    // 1. Create a child comment under testLoanAppId
    const comment = await realPrisma.loanComment.create({
      data: {
        loanApplicationId: testLoanAppId,
        authorAddress: "GAUDITOR1",
        content: "Audit integrity verification comment",
      },
    });

    // 2. Soft-delete the parent LoanApplication
    await realPrisma.loanApplication.update({
      where: { id: testLoanAppId },
      data: { deletedAt: new Date() },
    });

    // 3. Run audit against the seeded database
    const report = await runForeignKeyAudit({
      prismaClient: realPrisma,
      customRelations: [
        {
          childModel: "LoanComment",
          childTable: "LoanComment",
          childColumn: "loanApplicationId",
          parentModel: "LoanApplication",
          parentTable: "LoanApplication",
          parentColumn: "id",
          isNullable: false,
        },
      ],
    });

    // 4. Assert orphan detection
    const commentOrphanFinding = report.orphans.find(
      (o) => o.childTable === "LoanComment" && o.childColumn === "loanApplicationId"
    );
    expect(commentOrphanFinding).toBeDefined();
    expect(commentOrphanFinding?.type).toBe("SOFT_DELETE_ORPHAN");
    expect(commentOrphanFinding?.sampleOrphanIds).toContain(comment.id);

    // 5. Verify STRICT NON-DELETION: comment record must still exist in the database for human review
    const commentStillExists = await realPrisma.loanComment.findUnique({
      where: { id: comment.id },
    });
    expect(commentStillExists).not.toBeNull();
    expect(commentStillExists?.id).toBe(comment.id);

    // Restore parent deletedAt for subsequent tests
    await realPrisma.loanApplication.update({
      where: { id: testLoanAppId },
      data: { deletedAt: null },
    });
  });

  it("flags a custom relation missing from database foreign key constraints", async () => {
    // Define an unconstrained relation that does not exist in DB
    const syntheticMissingRelation: SchemaRelation = {
      childModel: "SyntheticChild",
      childTable: "SyntheticChild",
      childColumn: "missingParentId",
      parentModel: "SyntheticParent",
      parentTable: "SyntheticParent",
      parentColumn: "id",
      isNullable: false,
    };

    const report = await runForeignKeyAudit({
      prismaClient: realPrisma,
      customRelations: [syntheticMissingRelation],
    });

    expect(report.status).toBe("ISSUES_DETECTED");
    const missingFinding = report.missingConstraints.find(
      (m) => m.childTable === "SyntheticChild" && m.childColumn === "missingParentId"
    );
    expect(missingFinding).toBeDefined();
    expect(missingFinding?.status).toBe("MISSING_IN_DB");
  });
});
