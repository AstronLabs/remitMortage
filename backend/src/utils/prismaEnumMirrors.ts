// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Keeps locally-declared TypeScript enums in sync with their Prisma schema
 * enums (issue #1036).
 *
 * A few enums are declared in TypeScript as a string-literal union (so a module
 * type-checks without `prisma generate` having run) even though the same values
 * live in `prisma/schema.prisma`. Nothing forces the two to agree, so a value
 * added on one side can silently drift from the other. This module parses the
 * schema and compares each registered pair; `prismaEnumMirrors.test.ts` fails
 * CI when they diverge.
 *
 * Pairing is explicit on purpose. Two same-named types are deliberately left
 * out because they are not strict mirrors:
 *   - `LoanStatus` (services/loanStore.ts) carries the app-only `MANUAL_REVIEW`
 *     state, so it is a superset of the Prisma enum rather than a mirror.
 *   - `CommunicationChannel` (services/communicationTimeline.ts) is an
 *     email/SMS/in-app view, not the stored EMAIL/SMS/PUSH preference enum.
 *
 * To add a new pair, see docs/PRISMA_ENUM_MIRRORS.md.
 */

export interface EnumMirrorPair {
  /** Enum name as declared in `prisma/schema.prisma`. */
  prismaEnum: string;
  /** The TypeScript values that must match it, in any order. */
  values: readonly string[];
  /** Where the mirror is declared, for the failure message. */
  declaredIn: string;
}

export interface EnumMirrorFinding {
  prismaEnum: string;
  declaredIn: string;
  /** Values the Prisma enum has that the TypeScript mirror is missing. */
  missingFromTypeScript: string[];
  /** Values the TypeScript mirror has that the Prisma enum does not. */
  missingFromPrisma: string[];
  /** True when the schema no longer declares the Prisma enum at all. */
  prismaEnumMissing: boolean;
}

export interface EnumMirrorReport {
  ok: boolean;
  /** Number of registered pairs compared. */
  checked: number;
  findings: EnumMirrorFinding[];
}

/**
 * Extracts `enum Name { ... }` blocks from Prisma schema text. Comments and
 * blank lines are skipped, and a member's `@map(...)` (if any) is ignored, so
 * the compared values are the member *names* the generated client exposes.
 */
export function parsePrismaEnums(schemaText: string): Record<string, string[]> {
  const enums: Record<string, string[]> = {};
  let current: string | null = null;

  for (const rawLine of schemaText.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (current === null) {
      const block = /^enum\s+([A-Za-z_]\w*)\s*\{/.exec(line);
      if (block) {
        current = block[1];
        enums[current] = [];
      }
      continue;
    }

    if (line.startsWith("}")) {
      current = null;
      continue;
    }
    if (line === "" || line.startsWith("//")) continue;

    const member = /^([A-Za-z_]\w*)/.exec(line);
    if (member) enums[current].push(member[1]);
  }

  return enums;
}

function difference(values: readonly string[], other: readonly string[]): string[] {
  const seen = new Set(other);
  return values.filter((value) => !seen.has(value));
}

/** Compares each pair against the parsed Prisma enums, in any order. */
export function compareEnumMirrors(
  prismaEnums: Record<string, string[]>,
  mirrors: readonly EnumMirrorPair[]
): EnumMirrorFinding[] {
  const findings: EnumMirrorFinding[] = [];

  for (const mirror of mirrors) {
    const prismaValues = prismaEnums[mirror.prismaEnum];

    if (!prismaValues) {
      findings.push({
        prismaEnum: mirror.prismaEnum,
        declaredIn: mirror.declaredIn,
        missingFromTypeScript: [],
        missingFromPrisma: [],
        prismaEnumMissing: true,
      });
      continue;
    }

    const missingFromTypeScript = difference(prismaValues, mirror.values);
    const missingFromPrisma = difference(mirror.values, prismaValues);

    if (missingFromTypeScript.length > 0 || missingFromPrisma.length > 0) {
      findings.push({
        prismaEnum: mirror.prismaEnum,
        declaredIn: mirror.declaredIn,
        missingFromTypeScript,
        missingFromPrisma,
        prismaEnumMissing: false,
      });
    }
  }

  return findings;
}

/** Parses `schemaText` and returns whether every pair is still in sync. */
export function validateEnumMirrors(opts: {
  schemaText: string;
  mirrors: readonly EnumMirrorPair[];
}): EnumMirrorReport {
  const findings = compareEnumMirrors(parsePrismaEnums(opts.schemaText), opts.mirrors);
  return { ok: findings.length === 0, checked: opts.mirrors.length, findings };
}
