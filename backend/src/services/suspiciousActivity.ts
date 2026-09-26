import { prisma } from "./db.js";

export type SuspiciousRuleCode = "STRUCTURING" | "RAPID_CYCLE" | "VELOCITY_SPIKE";

export interface SuspiciousActivityConfig {
  structuringThreshold: bigint;
  structuringCount: number;
  windowHours: number;
  rapidCycleHours: number;
  velocityMultiplier: number;
  velocityMinimumTransactions: number;
}

export interface ActivityTransaction {
  id: string;
  kind: "deposit" | "withdrawal";
  amount: bigint;
  createdAt: Date;
  ledger: number;
}

export interface RuleFinding {
  code: SuspiciousRuleCode;
  name: string;
  evidence: Record<string, unknown>;
}

const DEFAULT_CONFIG: SuspiciousActivityConfig = {
  structuringThreshold: 10_000_000_000n,
  structuringCount: 3,
  windowHours: 24,
  rapidCycleHours: 6,
  velocityMultiplier: 3,
  velocityMinimumTransactions: 5,
};

export function loadSuspiciousActivityConfig(env: NodeJS.ProcessEnv = process.env): SuspiciousActivityConfig {
  const number = (key: string, fallback: number) => {
    const value = Number(env[key]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  return {
    structuringThreshold: BigInt(env.AML_STRUCTURING_THRESHOLD ?? DEFAULT_CONFIG.structuringThreshold),
    structuringCount: Math.floor(number("AML_STRUCTURING_COUNT", DEFAULT_CONFIG.structuringCount)),
    windowHours: number("AML_WINDOW_HOURS", DEFAULT_CONFIG.windowHours),
    rapidCycleHours: number("AML_RAPID_CYCLE_HOURS", DEFAULT_CONFIG.rapidCycleHours),
    velocityMultiplier: number("AML_VELOCITY_MULTIPLIER", DEFAULT_CONFIG.velocityMultiplier),
    velocityMinimumTransactions: Math.floor(number("AML_VELOCITY_MIN_TRANSACTIONS", DEFAULT_CONFIG.velocityMinimumTransactions)),
  };
}

export function evaluateSuspiciousActivity(
  transactions: ActivityTransaction[],
  config = DEFAULT_CONFIG,
  now = new Date(),
): RuleFinding[] {
  const windowStart = new Date(now.getTime() - config.windowHours * 60 * 60 * 1000);
  const recent = transactions.filter((transaction) => transaction.createdAt >= windowStart && transaction.createdAt <= now);
  const deposits = recent.filter((transaction) => transaction.kind === "deposit");
  const withdrawals = recent.filter((transaction) => transaction.kind === "withdrawal");
  const findings: RuleFinding[] = [];

  const nearThreshold = deposits.filter((transaction) => transaction.amount >= (config.structuringThreshold * 8n) / 10n && transaction.amount < config.structuringThreshold);
  if (nearThreshold.length >= config.structuringCount) {
    findings.push({
      code: "STRUCTURING",
      name: "Repeated deposits just below the reporting threshold",
      evidence: { threshold: config.structuringThreshold.toString(), transactions: nearThreshold.map((item) => ({ id: item.id, amount: item.amount.toString(), ledger: item.ledger })) },
    });
  }

  const rapidCycles = deposits.flatMap((deposit) => withdrawals
    .filter((withdrawal) => withdrawal.createdAt >= deposit.createdAt && withdrawal.createdAt.getTime() - deposit.createdAt.getTime() <= config.rapidCycleHours * 60 * 60 * 1000)
    .map((withdrawal) => [deposit, withdrawal] as const));
  if (rapidCycles.length > 0) {
    findings.push({
      code: "RAPID_CYCLE",
      name: "Deposit followed by rapid withdrawal",
      evidence: { pairs: rapidCycles.map(([deposit, withdrawal]) => ({ depositId: deposit.id, withdrawalId: withdrawal.id, depositAmount: deposit.amount.toString(), withdrawalAmount: withdrawal.amount.toString() })) },
    });
  }

  const baseline = transactions.filter((transaction) => transaction.createdAt < windowStart);
  const baselineCount = Math.max(1, baseline.length / Math.max(1, config.windowHours / 24));
  if (recent.length >= config.velocityMinimumTransactions && recent.length >= baselineCount * config.velocityMultiplier) {
    findings.push({ code: "VELOCITY_SPIKE", name: "Transaction velocity materially exceeds the account baseline", evidence: { recentCount: recent.length, baselineCount, multiplier: config.velocityMultiplier } });
  }
  return findings;
}

export async function runSuspiciousActivityScan(now = new Date()) {
  const config = loadSuspiciousActivityConfig();
  const borrowers = await prisma.borrower.findMany({
    where: { deletedAt: null },
    include: { deposits: true, withdrawals: true },
  });
  const windowStart = new Date(now.getTime() - config.windowHours * 60 * 60 * 1000);
  let created = 0;
  for (const borrower of borrowers) {
    const transactions: ActivityTransaction[] = [
      ...borrower.deposits.map((item: { id: string; amount: string; createdAt: Date; ledger: number }) => ({ id: item.id, kind: "deposit" as const, amount: BigInt(item.amount), createdAt: item.createdAt, ledger: item.ledger })),
      ...borrower.withdrawals.map((item: { id: string; amount: string; createdAt: Date; ledger: number }) => ({ id: item.id, kind: "withdrawal" as const, amount: BigInt(item.amount), createdAt: item.createdAt, ledger: item.ledger })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const finding of evaluateSuspiciousActivity(transactions, config, now)) {
      await prisma.suspiciousActivityAlert.upsert({
        where: { borrowerId_ruleCode_windowStart: { borrowerId: borrower.id, ruleCode: finding.code, windowStart } },
        create: { borrowerId: borrower.id, ruleCode: finding.code, ruleName: finding.name, windowStart, windowEnd: now, evidence: finding.evidence },
        update: { windowEnd: now, evidence: finding.evidence },
      });
      created++;
    }
  }
  return { scanned: borrowers.length, created };
}
