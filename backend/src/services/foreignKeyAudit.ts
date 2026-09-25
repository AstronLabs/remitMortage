import * as fs from "fs";
import * as path from "path";
import { prisma as defaultPrisma } from "./db.js";
import logger from "../utils/logger.js";

export interface SchemaRelation {
  childModel: string;
  childTable: string;
  childColumn: string;
  parentModel: string;
  parentTable: string;
  parentColumn: string;
  isNullable: boolean;
  onDelete?: string;
}

export interface DatabaseForeignKeyConstraint {
  constraintName: string;
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  isEnforced: boolean;
}

export interface MissingConstraintFinding {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  status: "MISSING_IN_DB" | "NOT_ENFORCED";
  description: string;
}

export interface OrphanFinding {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  orphanCount: number;
  sampleOrphanIds: string[];
  type: "HARD_DELETE_ORPHAN" | "SOFT_DELETE_ORPHAN";
  description: string;
}

export interface ForeignKeyAuditReport {
  timestamp: string;
  relationsCheckedCount: number;
  existingConstraintsCount: number;
  missingConstraints: MissingConstraintFinding[];
  orphans: OrphanFinding[];
  totalOrphanCount: number;
  totalMissingConstraintCount: number;
  status: "CLEAN" | "ISSUES_DETECTED";
  summary: string;
}

/**
 * Standard registry of documented relations in the RemitMortgage Prisma schema.
 * Serves as the authoritative referential baseline and fallback when the schema file
 * cannot be parsed dynamically at runtime.
 */
export const DOCUMENTED_SCHEMA_RELATIONS: SchemaRelation[] = [
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
    childModel: "WorkspaceMember",
    childTable: "WorkspaceMember",
    childColumn: "workspaceId",
    parentModel: "Workspace",
    parentTable: "Workspace",
    parentColumn: "id",
    isNullable: false,
    onDelete: "Cascade",
  },
  {
    childModel: "WorkspaceInvitation",
    childTable: "WorkspaceInvitation",
    childColumn: "workspaceId",
    parentModel: "Workspace",
    parentTable: "Workspace",
    parentColumn: "id",
    isNullable: false,
    onDelete: "Cascade",
  },
  {
    childModel: "BorrowerCredential",
    childTable: "BorrowerCredential",
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
    childModel: "LoanComment",
    childTable: "LoanComment",
    childColumn: "loanApplicationId",
    parentModel: "LoanApplication",
    parentTable: "LoanApplication",
    parentColumn: "id",
    isNullable: false,
    onDelete: "Cascade",
  },
  {
    childModel: "LoanComment",
    childTable: "LoanComment",
    childColumn: "parentId",
    parentModel: "LoanComment",
    parentTable: "LoanComment",
    parentColumn: "id",
    isNullable: true,
    onDelete: "Cascade",
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
  {
    childModel: "EscrowWithdrawal",
    childTable: "EscrowWithdrawal",
    childColumn: "borrowerId",
    parentModel: "Borrower",
    parentTable: "Borrower",
    parentColumn: "id",
    isNullable: false,
  },
  {
    childModel: "LoanDisbursement",
    childTable: "LoanDisbursement",
    childColumn: "borrowerId",
    parentModel: "Borrower",
    parentTable: "Borrower",
    parentColumn: "id",
    isNullable: false,
  },
  {
    childModel: "LoanRepayment",
    childTable: "LoanRepayment",
    childColumn: "borrowerId",
    parentModel: "Borrower",
    parentTable: "Borrower",
    parentColumn: "id",
    isNullable: false,
  },
  {
    childModel: "VerificationResult",
    childTable: "VerificationResult",
    childColumn: "applicantId",
    parentModel: "Applicant",
    parentTable: "Applicant",
    parentColumn: "id",
    isNullable: false,
  },
  {
    childModel: "WebhookDelivery",
    childTable: "WebhookDelivery",
    childColumn: "subscriptionId",
    parentModel: "WebhookSubscription",
    parentTable: "WebhookSubscription",
    parentColumn: "id",
    isNullable: false,
    onDelete: "Cascade",
  },
  {
    childModel: "KycDocumentMetadata",
    childTable: "KycDocumentMetadata",
    childColumn: "applicantId",
    parentModel: "Applicant",
    parentTable: "Applicant",
    parentColumn: "id",
    isNullable: false,
  },
  {
    childModel: "LoanAutoRejectionLog",
    childTable: "LoanAutoRejectionLog",
    childColumn: "applicationId",
    parentModel: "LoanApplication",
    parentTable: "LoanApplication",
    parentColumn: "id",
    isNullable: false,
    onDelete: "Cascade",
  },
  {
    childModel: "LoanAutoRejectionLog",
    childTable: "LoanAutoRejectionLog",
    childColumn: "ruleId",
    parentModel: "LoanAutoRejectionRule",
    parentTable: "LoanAutoRejectionRule",
    parentColumn: "id",
    isNullable: false,
    onDelete: "Cascade",
  },
];

/**
 * Parses relation declarations from a Prisma schema file content.
 */
export function parsePrismaSchemaRelations(schemaContent: string): SchemaRelation[] {
  const relations: SchemaRelation[] = [];
  const modelRegex = /model\s+(\w+)\s*\{([^}]+)\}/g;
  let modelMatch: RegExpExecArray | null;

  while ((modelMatch = modelRegex.exec(schemaContent)) !== null) {
    const modelName = modelMatch[1];
    const modelBody = modelMatch[2];
    const lines = modelBody.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;

      // Match relation: fieldName TargetModel[?] @relation(fields: [fkField], references: [pkField], ...)
      const relationMatch = trimmed.match(
        /^\w+\s+(\w+)(\??)\s+@relation\((?:.*fields:\s*\[([^\]]+)\].*references:\s*\[([^\]]+)\]|.*references:\s*\[([^\]]+)\].*fields:\s*\[([^\]]+)\])(?:.*onDelete:\s*(\w+))?.*\)/
      );

      if (relationMatch) {
        const targetModel = relationMatch[1];
        const isNullable = Boolean(relationMatch[2]);
        const childField = (relationMatch[3] || relationMatch[6] || "").trim();
        const parentField = (relationMatch[4] || relationMatch[5] || "").trim();
        const onDelete = relationMatch[7];

        if (childField && parentField) {
          relations.push({
            childModel: modelName,
            childTable: modelName,
            childColumn: childField,
            parentModel: targetModel,
            parentTable: targetModel,
            parentColumn: parentField,
            isNullable,
            onDelete,
          });
        }
      }
    }
  }

  return relations;
}

/**
 * Loads relations either dynamically from the committed prisma schema file
 * or from the compiled fallback registry.
 */
export function loadDocumentedRelations(schemaPath?: string): SchemaRelation[] {
  try {
    const resolvedPath =
      schemaPath ||
      path.resolve(process.cwd(), "prisma/schema.prisma") ||
      path.resolve(process.cwd(), "backend/prisma/schema.prisma");

    if (fs.existsSync(resolvedPath)) {
      const content = fs.readFileSync(resolvedPath, "utf8");
      const parsed = parsePrismaSchemaRelations(content);
      if (parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    logger.warn("[foreignKeyAudit] Unable to parse schema file directly, using documented registry", { err });
  }

  return [...DOCUMENTED_SCHEMA_RELATIONS];
}

/**
 * Queries the active PostgreSQL database for all existing foreign key constraints
 * in the public schema, including their enforcement validation status.
 */
export async function getDatabaseForeignKeyConstraints(
  prismaClient: any = defaultPrisma
): Promise<DatabaseForeignKeyConstraint[]> {
  try {
    const rawConstraints: any[] = await prismaClient.$queryRaw`
      SELECT
        tc.constraint_name,
        tc.table_name AS child_table,
        kcu.column_name AS child_column,
        ccu.table_name AS parent_table,
        ccu.column_name AS parent_column,
        COALESCE(c.convalidated, true) AS is_enforced
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      LEFT JOIN pg_constraint c
        ON c.conname = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public';
    `;

    return rawConstraints.map((row) => ({
      constraintName: String(row.constraint_name),
      childTable: String(row.child_table),
      childColumn: String(row.child_column),
      parentTable: String(row.parent_table),
      parentColumn: String(row.parent_column),
      isEnforced: Boolean(row.is_enforced),
    }));
  } catch (error) {
    logger.error("[foreignKeyAudit] Failed to query information_schema constraints", { error });
    return [];
  }
}

/**
 * Cross-checks documented schema relations against actual database-level constraints.
 * Flags any relation that lacks an enforced database foreign key constraint.
 */
export function crossCheckConstraints(
  schemaRelations: SchemaRelation[],
  databaseConstraints: DatabaseForeignKeyConstraint[]
): MissingConstraintFinding[] {
  const findings: MissingConstraintFinding[] = [];

  for (const relation of schemaRelations) {
    const matchingConstraint = databaseConstraints.find(
      (c) =>
        c.childTable.toLowerCase() === relation.childTable.toLowerCase() &&
        c.childColumn.toLowerCase() === relation.childColumn.toLowerCase() &&
        c.parentTable.toLowerCase() === relation.parentTable.toLowerCase() &&
        c.parentColumn.toLowerCase() === relation.parentColumn.toLowerCase()
    );

    if (!matchingConstraint) {
      findings.push({
        childTable: relation.childTable,
        childColumn: relation.childColumn,
        parentTable: relation.parentTable,
        parentColumn: relation.parentColumn,
        status: "MISSING_IN_DB",
        description: `Relation ${relation.childTable}.${relation.childColumn} -> ${relation.parentTable}.${relation.parentColumn} has no enforced foreign key constraint in the database.`,
      });
    } else if (!matchingConstraint.isEnforced) {
      findings.push({
        childTable: relation.childTable,
        childColumn: relation.childColumn,
        parentTable: relation.parentTable,
        parentColumn: relation.parentColumn,
        status: "NOT_ENFORCED",
        description: `Constraint ${matchingConstraint.constraintName} on ${relation.childTable}.${relation.childColumn} exists but is marked NOT VALID (not enforced).`,
      });
    }
  }

  return findings;
}

/**
 * Scans each documented relation for orphaned rows (rows referencing a non-existent
 * or deleted parent).
 *
 * NOTE: Strictly read-only audit. Does NOT delete or alter any data.
 */
export async function scanOrphanedRows(
  prismaClient: any = defaultPrisma,
  relations: SchemaRelation[]
): Promise<OrphanFinding[]> {
  const findings: OrphanFinding[] = [];

  for (const rel of relations) {
    try {
      // 1. Check for hard-deleted parents (dangling reference where parent row is missing)
      const orphanCountResult: any[] = await prismaClient.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS count
        FROM "${rel.childTable}" c
        LEFT JOIN "${rel.parentTable}" p
          ON c."${rel.childColumn}" = p."${rel.parentColumn}"
        WHERE c."${rel.childColumn}" IS NOT NULL
          AND p."${rel.parentColumn}" IS NULL;
      `);

      const hardOrphanCount = Number(orphanCountResult?.[0]?.count || 0);

      if (hardOrphanCount > 0) {
        const sampleRows: any[] = await prismaClient.$queryRawUnsafe(`
          SELECT c.id::text AS id
          FROM "${rel.childTable}" c
          LEFT JOIN "${rel.parentTable}" p
            ON c."${rel.childColumn}" = p."${rel.parentColumn}"
          WHERE c."${rel.childColumn}" IS NOT NULL
            AND p."${rel.parentColumn}" IS NULL
          LIMIT 10;
        `);

        findings.push({
          childTable: rel.childTable,
          childColumn: rel.childColumn,
          parentTable: rel.parentTable,
          parentColumn: rel.parentColumn,
          orphanCount: hardOrphanCount,
          sampleOrphanIds: sampleRows.map((r) => String(r.id)),
          type: "HARD_DELETE_ORPHAN",
          description: `Found ${hardOrphanCount} orphaned row(s) in "${rel.childTable}" referencing non-existent parent in "${rel.parentTable}".`,
        });
      }

      // 2. Check for soft-deleted parents (where parent table has deletedAt set)
      try {
        const softOrphanCountResult: any[] = await prismaClient.$queryRawUnsafe(`
          SELECT COUNT(*)::int AS count
          FROM "${rel.childTable}" c
          JOIN "${rel.parentTable}" p
            ON c."${rel.childColumn}" = p."${rel.parentColumn}"
          WHERE p."deletedAt" IS NOT NULL
            AND (c."deletedAt" IS NULL OR NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = '${rel.childTable}' AND column_name = 'deletedAt'
            ));
        `);

        const softOrphanCount = Number(softOrphanCountResult?.[0]?.count || 0);

        if (softOrphanCount > 0) {
          const sampleSoftRows: any[] = await prismaClient.$queryRawUnsafe(`
            SELECT c.id::text AS id
            FROM "${rel.childTable}" c
            JOIN "${rel.parentTable}" p
              ON c."${rel.childColumn}" = p."${rel.parentColumn}"
            WHERE p."deletedAt" IS NOT NULL
            LIMIT 10;
          `);

          findings.push({
            childTable: rel.childTable,
            childColumn: rel.childColumn,
            parentTable: rel.parentTable,
            parentColumn: rel.parentColumn,
            orphanCount: softOrphanCount,
            sampleOrphanIds: sampleSoftRows.map((r) => String(r.id)),
            type: "SOFT_DELETE_ORPHAN",
            description: `Found ${softOrphanCount} row(s) in "${rel.childTable}" referencing a soft-deleted parent in "${rel.parentTable}".`,
          });
        }
      } catch {
        // Table does not have deletedAt column, skip soft-delete check
      }
    } catch (err) {
      logger.warn(
        `[foreignKeyAudit] Skipped table scan for relation ${rel.childTable}.${rel.childColumn} -> ${rel.parentTable}.${rel.parentColumn}`,
        { err }
      );
    }
  }

  return findings;
}

export interface ForeignKeyAuditOptions {
  prismaClient?: any;
  schemaPath?: string;
  customRelations?: SchemaRelation[];
}

/**
 * Runs the comprehensive Automated Foreign Key Constraint and Referential Integrity Audit.
 *
 * 1. Loads all documented relations from schema and registry.
 * 2. Queries active database constraints and detects referential gaps.
 * 3. Scans for orphaned or dangling rows.
 * 4. Compiles a detailed, actionable audit report without deleting anything.
 */
export async function runForeignKeyAudit(
  options: ForeignKeyAuditOptions = {}
): Promise<ForeignKeyAuditReport> {
  const prismaClient = options.prismaClient || defaultPrisma;
  const relations = options.customRelations || loadDocumentedRelations(options.schemaPath);

  logger.info("[foreignKeyAudit] Starting automated referential integrity audit", {
    relationsCount: relations.length,
  });

  const dbConstraints = await getDatabaseForeignKeyConstraints(prismaClient);
  const missingConstraints = crossCheckConstraints(relations, dbConstraints);
  const orphans = await scanOrphanedRows(prismaClient, relations);

  const totalOrphanCount = orphans.reduce((sum, o) => sum + o.orphanCount, 0);
  const totalMissingConstraintCount = missingConstraints.length;

  const hasIssues = totalOrphanCount > 0 || totalMissingConstraintCount > 0;
  const status: "CLEAN" | "ISSUES_DETECTED" = hasIssues ? "ISSUES_DETECTED" : "CLEAN";

  const summary = hasIssues
    ? `Referential integrity audit detected ${totalOrphanCount} orphaned row(s) across ${orphans.length} relation(s) and ${totalMissingConstraintCount} schema relation(s) missing database-level foreign key constraints.`
    : `All ${relations.length} documented schema relation(s) have verified database-level constraints with 0 orphaned rows detected.`;

  const report: ForeignKeyAuditReport = {
    timestamp: new Date().toISOString(),
    relationsCheckedCount: relations.length,
    existingConstraintsCount: dbConstraints.length,
    missingConstraints,
    orphans,
    totalOrphanCount,
    totalMissingConstraintCount,
    status,
    summary,
  };

  logger.info("[foreignKeyAudit] Audit sweep complete", {
    status,
    totalOrphans: totalOrphanCount,
    totalMissingConstraints: totalMissingConstraintCount,
  });

  return report;
}
