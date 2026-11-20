// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Guards the TypeScript mirrors of Prisma enums (issue #1036).
 *
 * Each entry in `MIRRORS` pairs a Prisma schema enum with the TypeScript values
 * that must match it exactly. The test parses `prisma/schema.prisma` and fails
 * when a value exists on one side only.
 *
 * Adding a pair is a single step: export an `as const` array of the values from
 * the module that declares the mirror, then add one entry to `MIRRORS` below.
 * See docs/PRISMA_ENUM_MIRRORS.md.
 */

import fs from "fs";
import path from "path";

import { NOTIFICATION_FREQUENCIES, VERIFICATION_STATUSES } from "../services/db.js";
import { GUARANTOR_STATUSES } from "../services/loanStore.js";
import { REVIEWER_STATUSES } from "../services/assignmentQueue.js";
import {
  COMMUNICATION_CATEGORIES,
  COMMUNICATION_CHANNELS,
} from "../services/communicationPreferences.js";
import {
  compareEnumMirrors,
  parsePrismaEnums,
  validateEnumMirrors,
  type EnumMirrorPair,
} from "../utils/prismaEnumMirrors.js";

const SCHEMA_PATH = path.resolve(__dirname, "../../prisma/schema.prisma");
const schemaText = fs.readFileSync(SCHEMA_PATH, "utf-8");

const MIRRORS: readonly EnumMirrorPair[] = [
  {
    prismaEnum: "VerificationStatus",
    values: VERIFICATION_STATUSES,
    declaredIn: "services/db.ts",
  },
  {
    prismaEnum: "NotificationFrequency",
    values: NOTIFICATION_FREQUENCIES,
    declaredIn: "services/db.ts",
  },
  {
    prismaEnum: "GuarantorStatus",
    values: GUARANTOR_STATUSES,
    declaredIn: "services/loanStore.ts",
  },
  {
    prismaEnum: "ReviewerStatus",
    values: REVIEWER_STATUSES,
    declaredIn: "services/assignmentQueue.ts",
  },
  {
    prismaEnum: "CommunicationCategory",
    values: COMMUNICATION_CATEGORIES,
    declaredIn: "services/communicationPreferences.ts",
  },
  {
    prismaEnum: "CommunicationChannel",
    values: COMMUNICATION_CHANNELS,
    declaredIn: "services/communicationPreferences.ts",
  },
];

describe("parsePrismaEnums", () => {
  it("reads enum members and ignores comments, blank lines, and @map", () => {
    const parsed = parsePrismaEnums(
      [
        "enum Role {",
        "  /// the workspace owner",
        "  OWNER",
        '  BUILDER @map("builder_role")',
        "}",
        "",
        "enum Empty {",
        "}",
      ].join("\n")
    );

    expect(parsed.Role).toEqual(["OWNER", "BUILDER"]);
    expect(parsed.Empty).toEqual([]);
  });
});

describe("compareEnumMirrors", () => {
  const pair = (values: string[]): EnumMirrorPair[] => [
    { prismaEnum: "Colour", values, declaredIn: "test" },
  ];

  it("passes when the values match", () => {
    expect(compareEnumMirrors({ Colour: ["RED", "GREEN"] }, pair(["RED", "GREEN"]))).toEqual([]);
  });

  it("treats reordered values as in sync", () => {
    expect(compareEnumMirrors({ Colour: ["RED", "GREEN"] }, pair(["GREEN", "RED"]))).toEqual([]);
  });

  it("flags a value the Prisma enum has but TypeScript lacks", () => {
    const findings = compareEnumMirrors({ Colour: ["RED", "GREEN"] }, pair(["RED"]));

    expect(findings).toEqual([
      {
        prismaEnum: "Colour",
        declaredIn: "test",
        missingFromTypeScript: ["GREEN"],
        missingFromPrisma: [],
        prismaEnumMissing: false,
      },
    ]);
  });

  it("flags a value TypeScript has but the Prisma enum lacks", () => {
    const findings = compareEnumMirrors({ Colour: ["RED"] }, pair(["RED", "BLUE"]));

    expect(findings[0].missingFromPrisma).toEqual(["BLUE"]);
    expect(findings[0].missingFromTypeScript).toEqual([]);
  });

  it("flags a mirror whose Prisma enum no longer exists", () => {
    const findings = compareEnumMirrors({}, pair(["RED"]));

    expect(findings[0].prismaEnumMissing).toBe(true);
  });
});

describe("the Prisma schema and its TypeScript mirrors", () => {
  it("keeps every paired enum in sync", () => {
    const report = validateEnumMirrors({ schemaText, mirrors: MIRRORS });

    expect(report.checked).toBe(MIRRORS.length);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails when a new Prisma enum value has no TypeScript counterpart", () => {
    const drifted = schemaText.replace(
      /enum ReviewerStatus \{\n\s+ACTIVE/,
      "enum ReviewerStatus {\n  ACTIVE\n  SUSPENDED"
    );

    const report = validateEnumMirrors({ schemaText: drifted, mirrors: MIRRORS });

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.prismaEnum)).toContain("ReviewerStatus");
    expect(report.findings[0].missingFromTypeScript).toContain("SUSPENDED");
  });
});
