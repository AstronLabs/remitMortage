// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Applicant list query (issue #993).
 *
 * Admin tooling previously had no paginated applicant list — only search and
 * per-applicant detail endpoints. This exposes a cursor-paginated, PII-light
 * summary so large applicant tables can be browsed without OFFSET scans or
 * duplicate rows when new applicants arrive between requests.
 */

import { prisma } from "./db.js";
import {
  buildPage,
  cursorWhere,
  encodeCursor,
  type CursorPosition,
  type Page,
} from "../utils/pagination.js";

export interface ApplicantSummary {
  id: string;
  stellarAddress: string;
  verificationStatus: string;
  creditScore: number | null;
  createdAt: string;
}

export interface ApplicantPageOptions {
  limit: number;
  cursor: CursorPosition | null;
}

export async function listApplicantsPage(
  options: ApplicantPageOptions
): Promise<Page<ApplicantSummary>> {
  const cursorFilter = cursorWhere(options.cursor, "createdAt");
  const rows = (await prisma.applicant.findMany({
    where: { deletedAt: null, ...(cursorFilter ?? {}) },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    select: {
      id: true,
      stellarAddress: true,
      verificationStatus: true,
      creditScore: true,
      createdAt: true,
    },
  })) as any[];

  const page = buildPage(
    rows.map((row) => ({
      id: row.id,
      stellarAddress: row.stellarAddress,
      verificationStatus: row.verificationStatus,
      creditScore: row.creditScore ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
    options.limit,
    (row) => encodeCursor(row.createdAt, row.id)
  );

  return page;
}
