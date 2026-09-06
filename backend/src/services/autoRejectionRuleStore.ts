import { prisma } from "./db.js";
import {
  applicantSnapshotFromRecord,
  evaluateApplicantAgainstRules,
  formatAutoRejectionReason,
  type AutoRejectionRuleRecord,
  type RuleEvaluationResult,
} from "./autoRejectionRules.js";
import type { AutoRejectionRuleType } from "@prisma/client";

function mapRule(record: {
  id: string;
  name: string;
  ruleType: AutoRejectionRuleType;
  config: unknown;
  active: boolean;
  priority: number;
}): AutoRejectionRuleRecord {
  return {
    id: record.id,
    name: record.name,
    ruleType: record.ruleType,
    config: record.config as AutoRejectionRuleRecord["config"],
    active: record.active,
    priority: record.priority,
  };
}

export async function listAutoRejectionRules(includeInactive = false) {
  const rules = await prisma.loanAutoRejectionRule.findMany({
    where: includeInactive ? undefined : { active: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  });
  return rules.map(mapRule);
}

export async function createAutoRejectionRule(input: {
  name: string;
  ruleType: AutoRejectionRuleType;
  config: Record<string, unknown>;
  active?: boolean;
  priority?: number;
}) {
  const rule = await prisma.loanAutoRejectionRule.create({
    data: {
      name: input.name,
      ruleType: input.ruleType,
      config: input.config,
      active: input.active ?? true,
      priority: input.priority ?? 0,
    },
  });
  return mapRule(rule);
}

export async function updateAutoRejectionRule(
  id: string,
  patch: Partial<{
    name: string;
    config: Record<string, unknown>;
    active: boolean;
    priority: number;
  }>
) {
  const rule = await prisma.loanAutoRejectionRule.update({
    where: { id },
    data: patch,
  });
  return mapRule(rule);
}

export async function evaluateLoanApplication(
  applicationId: string,
  applicantId: string,
  principal: number
): Promise<RuleEvaluationResult> {
  const [rules, applicant] = await Promise.all([
    listAutoRejectionRules(false),
    prisma.applicant.findUnique({ where: { id: applicantId } }),
  ]);

  if (!applicant) {
    return { rejected: false, failures: [] };
  }

  return evaluateApplicantAgainstRules(
    rules,
    applicantSnapshotFromRecord(applicant),
    principal
  );
}

export async function applyAutoRejectionIfNeeded(
  applicationId: string,
  applicantId: string,
  principal: number,
  notifyEmail?: string
): Promise<{ autoRejected: boolean; evaluation: RuleEvaluationResult }> {
  const evaluation = await evaluateLoanApplication(applicationId, applicantId, principal);
  if (!evaluation.rejected) {
    return { autoRejected: false, evaluation };
  }

  const reason = formatAutoRejectionReason(evaluation.failures);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.loanApplication.update({
      where: { id: applicationId },
      data: {
        status: "Rejected",
        reason,
        autoRejectedAt: now,
        statusUpdatedAt: now,
      },
    });

    for (const failure of evaluation.failures) {
      await tx.loanAutoRejectionLog.create({
        data: {
          applicationId,
          ruleId: failure.ruleId,
          reason: failure.reason,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "loan_application.auto_rejected",
          metadata: {
            applicationId,
            ruleId: failure.ruleId,
            ruleName: failure.ruleName,
            ruleType: failure.ruleType,
            reason: failure.reason,
          },
        },
      });
    }
  });

  if (notifyEmail) {
    const { queueNotification } = await import("./notification.js");
    await queueNotification(
      notifyEmail,
      "EMAIL",
      JSON.stringify({
        template: "loan_auto_rejected",
        applicationId,
        reason,
        failedRules: evaluation.failures.map((f) => ({
          ruleName: f.ruleName,
          reason: f.reason,
        })),
      })
    );
  }

  return { autoRejected: true, evaluation };
}
