import { PrismaClient } from '@prisma/client';
import { readFile } from 'node:fs/promises';

const prisma = new PrismaClient();
const baselinePath = new URL('../query-plan-baselines.json', import.meta.url);

type Baseline = {
  name: string;
  expectedNodeTypes: string[];
  expectedIndexes: string[];
};

function collectNodes(plan: any, nodes: string[] = [], indexes: string[] = []) {
  if (!plan || typeof plan !== 'object') return { nodes, indexes };
  if (typeof plan['Node Type'] === 'string') nodes.push(plan['Node Type']);
  if (typeof plan['Index Name'] === 'string') indexes.push(plan['Index Name']);
  for (const child of plan.Plans ?? []) collectNodes(child, nodes, indexes);
  return { nodes, indexes };
}

async function main() {
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline[];
  const explain = await prisma.$queryRaw<any[]>`
    EXPLAIN (FORMAT JSON)
    SELECT "LoanApplication"."id", "Applicant"."stellarAddress"
    FROM "LoanApplication"
    LEFT JOIN "Applicant" ON "LoanApplication"."applicantId" = "Applicant"."id"
    WHERE "LoanApplication"."applicantId" = 'test-0-0'
  `;
  const plan = explain[0]['QUERY PLAN'][0].Plan;
  const actual = collectNodes(plan);
  const failures: string[] = [];
  for (const query of baseline) {
    for (const node of query.expectedNodeTypes) {
      if (!actual.nodes.includes(node)) failures.push(`${query.name}: missing node ${node}`);
    }
    for (const index of query.expectedIndexes) {
      if (!actual.indexes.includes(index)) failures.push(`${query.name}: missing index ${index}`);
    }
    if (actual.nodes.includes('Seq Scan')) failures.push(`${query.name}: sequential scan detected`);
  }
  console.log(JSON.stringify({ baseline, actual }, null, 2));
  if (failures.length) {
    console.error(`Query plan regression:\n${failures.join('\n')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
