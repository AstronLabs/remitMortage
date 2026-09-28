// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Tests for recording and reviewing document forgery flags (issue #813).
 *
 * Acceptance criteria under test:
 * - A flagged document is stored for manual review (not rejected) and the
 *   specific triggering signals are logged and persisted.
 * - A clean document is recorded without a flag or a warning.
 */

interface Row {
  documentId: string;
  applicantAddress: string;
  format: string;
  flagged: boolean;
  signals: any[];
  analyzedAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string | null;
  reviewOutcome: string | null;
  reviewNote: string | null;
}

let rows: Row[] = [];
const auditLogCreateMock = jest.fn();
const loggerWarnMock = jest.fn();
const loggerErrorMock = jest.fn();

jest.mock("../services/db.js", () => ({
  prisma: {
    kycDocumentForensics: {
      create: jest.fn(async ({ data }: any) => {
        const row: Row = {
          analyzedAt: new Date(),
          reviewedAt: null,
          reviewedBy: null,
          reviewOutcome: null,
          reviewNote: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.flagged === where.flagged && r.reviewedAt === where.reviewedAt)
      ),
      findUnique: jest.fn(async ({ where }: any) => rows.find((r) => r.documentId === where.documentId) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.documentId === where.documentId)!;
        Object.assign(row, data);
        return row;
      }),
    },
    auditLog: { create: (...args: unknown[]) => auditLogCreateMock(...args) },
  },
}));

jest.mock("../utils/logger.js", () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: (...args: unknown[]) => loggerWarnMock(...args),
  error: (...args: unknown[]) => loggerErrorMock(...args),
}));

import {
  ForensicsReviewError,
  analyzeAndRecordDocument,
  listFlaggedDocuments,
  reviewFlaggedDocument,
} from "../services/kycDocumentForensics.js";

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

function png(software?: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13)),
    ...(software ? [pngChunk("tEXt", Buffer.from(`Software\0${software}`, "latin1"))] : []),
    pngChunk("IDAT", Buffer.from([1, 2, 3])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

beforeEach(() => {
  rows = [];
  jest.clearAllMocks();
  auditLogCreateMock.mockResolvedValue({});
});

describe("analyzeAndRecordDocument", () => {
  it("flags a tampered document for review, persisting and logging the specific signals", async () => {
    const result = await analyzeAndRecordDocument({
      documentId: "doc-1",
      applicantAddress: "GAPPLICANT",
      buffer: png("Adobe Photoshop 25.1 (Windows)"),
      mimeType: "image/png",
    });

    expect(result?.flagged).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ documentId: "doc-1", flagged: true, format: "png" });
    expect(rows[0].signals[0]).toMatchObject({
      code: "editing_software_signature",
      severity: "high",
      evidence: expect.stringContaining("Adobe Photoshop 25.1 (Windows)"),
    });

    // The reviewer-facing log names the exact signal and evidence, not a generic label.
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("flagged for manual review"),
      expect.objectContaining({
        documentId: "doc-1",
        signals: [
          expect.objectContaining({
            code: "editing_software_signature",
            evidence: expect.stringContaining("Adobe Photoshop"),
          }),
        ],
      })
    );
    expect(auditLogCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "KYC_DOCUMENT_FLAGGED",
          metadata: expect.objectContaining({ signalCodes: ["editing_software_signature"] }),
        }),
      })
    );
  });

  it("records a clean document without a flag, warning, or audit entry", async () => {
    const result = await analyzeAndRecordDocument({
      documentId: "doc-2",
      applicantAddress: "GAPPLICANT",
      buffer: png(),
      mimeType: "image/png",
    });

    expect(result?.flagged).toBe(false);
    expect(rows[0]).toMatchObject({ documentId: "doc-2", flagged: false, signals: [] });
    expect(loggerWarnMock).not.toHaveBeenCalled();
    expect(auditLogCreateMock).not.toHaveBeenCalled();
  });

  it("never throws when storage fails — the upload it follows has already succeeded", async () => {
    const { prisma } = jest.requireMock("../services/db.js") as any;
    prisma.kycDocumentForensics.create.mockRejectedValueOnce(new Error("db down"));

    await expect(
      analyzeAndRecordDocument({
        documentId: "doc-3",
        applicantAddress: "GAPPLICANT",
        buffer: png("GIMP 2.10"),
        mimeType: "image/png",
      })
    ).resolves.toMatchObject({ flagged: true });
    expect(loggerErrorMock).toHaveBeenCalled();
  });

  it("never throws on an empty or unrecognizable buffer", async () => {
    await expect(
      analyzeAndRecordDocument({
        documentId: "doc-4",
        applicantAddress: "GAPPLICANT",
        buffer: Buffer.alloc(0),
        mimeType: "application/pdf",
      })
    ).resolves.toMatchObject({ flagged: false, format: "unknown" });
  });
});

describe("review queue", () => {
  async function seed(documentId: string, software?: string) {
    await analyzeAndRecordDocument({
      documentId,
      applicantAddress: "GAPPLICANT",
      buffer: png(software),
      mimeType: "image/png",
    });
  }

  it("lists only flagged documents that have not been reviewed yet", async () => {
    await seed("flagged-a", "Adobe Photoshop 25");
    await seed("flagged-b", "GIMP 2.10");
    await seed("clean-c");
    await reviewFlaggedDocument({ documentId: "flagged-b", reviewedBy: "GADMIN", outcome: "CLEARED" });

    const queue = await listFlaggedDocuments();
    expect(queue.map((r: Row) => r.documentId)).toEqual(["flagged-a"]);
  });

  it("records the reviewer's resolution, outcome and note", async () => {
    await seed("flagged-a", "Adobe Photoshop 25");

    const reviewed = await reviewFlaggedDocument({
      documentId: "flagged-a",
      reviewedBy: "GADMIN",
      outcome: "CONFIRMED_TAMPERED",
      note: "Name field visibly re-typed.",
    });

    expect(reviewed).toMatchObject({
      reviewedBy: "GADMIN",
      reviewOutcome: "CONFIRMED_TAMPERED",
      reviewNote: "Name field visibly re-typed.",
    });
    expect(reviewed.reviewedAt).toBeInstanceOf(Date);
  });

  it("rejects an invalid outcome, an unknown document, an unflagged document, and a second review", async () => {
    await seed("flagged-a", "Adobe Photoshop 25");
    await seed("clean-c");

    await expect(
      reviewFlaggedDocument({ documentId: "flagged-a", reviewedBy: "GADMIN", outcome: "MAYBE" })
    ).rejects.toMatchObject({ code: "invalid_outcome" });
    await expect(
      reviewFlaggedDocument({ documentId: "nope", reviewedBy: "GADMIN", outcome: "CLEARED" })
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      reviewFlaggedDocument({ documentId: "clean-c", reviewedBy: "GADMIN", outcome: "CLEARED" })
    ).rejects.toMatchObject({ code: "not_flagged" });

    await reviewFlaggedDocument({ documentId: "flagged-a", reviewedBy: "GADMIN", outcome: "CLEARED" });
    await expect(
      reviewFlaggedDocument({ documentId: "flagged-a", reviewedBy: "GADMIN", outcome: "CLEARED" })
    ).rejects.toBeInstanceOf(ForensicsReviewError);
  });
});
