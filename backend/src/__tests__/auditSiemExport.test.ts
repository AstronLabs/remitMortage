// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

jest.mock("../services/db.js");
jest.mock("../services/audit.js");
jest.mock("../utils/logger.js", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { prisma } from "../services/db.js";
import { logAudit } from "../services/audit.js";
import {
  exportAuditLogToSiem,
  buildExportChainHash,
  formatAsCef,
  formatAsNdjson,
  SIEM_EXPORT_PAGE_SIZE,
  SIEM_MAX_WINDOW_DAYS,
  AuditExportEvent,
} from "../services/auditSiemExport.js";
import {
  DEFAULT_EXPORT_REDACTION_LEVEL,
  maskIdentifier,
  redactMetadata,
  resolveExportRedactionLevel,
  truncateIp,
} from "../services/exportRedaction.js";

const mockLogAudit = logAudit as jest.Mock;

const from = new Date("2026-08-01T00:00:00Z");
const to = new Date("2026-08-02T00:00:00Z");
const SECRET = "test-hmac-secret";

function makeRow(id: string, action = "loan.approved", createdAt?: Date) {
  return {
    id,
    action,
    actorAddress: "G-ACTOR",
    ipAddress: "10.0.0.1",
    metadata: { loanId: "L1" },
    createdAt: createdAt ?? new Date("2026-08-01T06:00:00Z"),
  };
}

function makeEvent(id: string): AuditExportEvent {
  return {
    id,
    action: "loan.approved",
    actorAddress: "G-ACTOR",
    ipAddress: "10.0.0.1",
    metadata: { loanId: "L1" },
    createdAt: new Date("2026-08-01T06:00:00Z").toISOString(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLogAudit.mockImplementation(() => {});
  (prisma.auditLog as any) = { findMany: jest.fn() };
});

// ── Window validation ─────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – window validation", () => {
  it("rejects when 'to' is before 'from'", async () => {
    await expect(
      exportAuditLogToSiem({ from: to, to: from }, SECRET, async () => {})
    ).rejects.toThrow("'to' must be after 'from'");
  });

  it(`rejects windows exceeding ${SIEM_MAX_WINDOW_DAYS} days`, async () => {
    const bigTo = new Date(
      from.getTime() + (SIEM_MAX_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1_000
    );
    await expect(
      exportAuditLogToSiem({ from, to: bigTo }, SECRET, async () => {})
    ).rejects.toThrow(`cannot exceed ${SIEM_MAX_WINDOW_DAYS} days`);
  });
});

// ── Pagination ────────────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – pagination", () => {
  it("calls onPage for each page of results", async () => {
    const page1 = Array.from({ length: SIEM_EXPORT_PAGE_SIZE }, (_, i) =>
      makeRow(`r-${i}`)
    );
    const page2 = [makeRow("r-last")];

    const findMany = jest.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce([]);
    (prisma.auditLog as any) = { findMany };

    const pages: string[][] = [];
    await exportAuditLogToSiem({ from, to, redactionLevel: "full" }, SECRET, async (lines) => {
      pages.push(lines);
    });

    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(SIEM_EXPORT_PAGE_SIZE);
    expect(pages[1]).toHaveLength(1);
  });

  it("reports correct totalEvents across pages", async () => {
    const findMany = jest.fn()
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => makeRow(`r-${i}`)))
      .mockResolvedValueOnce([]);
    (prisma.auditLog as any) = { findMany };

    const result = await exportAuditLogToSiem({ from, to }, SECRET, async () => {});
    expect(result.totalEvents).toBe(10);
  });

  it("uses keyset pagination (passes last id as cursor)", async () => {
    const page1 = Array.from({ length: SIEM_EXPORT_PAGE_SIZE }, (_, i) =>
      makeRow(`r-${i}`)
    );
    const findMany = jest.fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce([]);
    (prisma.auditLog as any) = { findMany };

    await exportAuditLogToSiem({ from, to }, SECRET, async () => {});

    const secondCall = findMany.mock.calls[1][0];
    expect(secondCall.where.id).toEqual({ gt: `r-${SIEM_EXPORT_PAGE_SIZE - 1}` });
  });
});

// ── Filters ───────────────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – filters", () => {
  it("passes action filter to the query when provided", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    (prisma.auditLog as any) = { findMany };

    await exportAuditLogToSiem(
      { from, to, actions: ["loan.approved"] },
      SECRET,
      async () => {}
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ action: { in: ["loan.approved"] } }),
      })
    );
  });

  it("passes actorAddress filter when provided", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    (prisma.auditLog as any) = { findMany };

    await exportAuditLogToSiem(
      { from, to, actorAddress: "G-TEST" },
      SECRET,
      async () => {}
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ actorAddress: "G-TEST" }),
      })
    );
  });
});

// ── Format helpers ────────────────────────────────────────────────────────────

describe("formatAsNdjson", () => {
  it("produces valid JSON for each event", () => {
    const line = formatAsNdjson(makeEvent("e-1"));
    const parsed = JSON.parse(line);
    expect(parsed.id).toBe("e-1");
    expect(parsed.action).toBe("loan.approved");
  });
});

describe("formatAsCef", () => {
  it("starts with the CEF header prefix", () => {
    const line = formatAsCef(makeEvent("e-1"));
    expect(line).toMatch(/^CEF:0\|RemitMortgage\|AuditLog/);
  });

  it("includes the event id and action in the CEF output", () => {
    const line = formatAsCef(makeEvent("e-cef"));
    expect(line).toContain("e-cef");
    expect(line).toContain("loan.approved");
  });

  it("includes the actor address in the extension", () => {
    const line = formatAsCef(makeEvent("e-actor"));
    expect(line).toContain("suser=G-ACTOR");
  });
});

// ── Hash-chain integrity ──────────────────────────────────────────────────────

describe("buildExportChainHash", () => {
  it("produces a hex string", () => {
    const hash = buildExportChainHash(["line1", "line2"], SECRET);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same hash for the same input", () => {
    const lines = ["a", "b", "c"];
    expect(buildExportChainHash(lines, SECRET)).toBe(
      buildExportChainHash(lines, SECRET)
    );
  });

  it("produces a different hash when a line is changed", () => {
    const base = buildExportChainHash(["a", "b"], SECRET);
    const modified = buildExportChainHash(["a", "B"], SECRET);
    expect(base).not.toBe(modified);
  });

  it("produces a different hash with a different secret", () => {
    const lines = ["line"];
    const h1 = buildExportChainHash(lines, "secret-1");
    const h2 = buildExportChainHash(lines, "secret-2");
    expect(h1).not.toBe(h2);
  });

  it("export result includes the chain hash", async () => {
    (prisma.auditLog as any) = {
      findMany: jest.fn().mockResolvedValue([makeRow("r-1")]),
    };

    const result = await exportAuditLogToSiem({ from, to }, SECRET, async () => {});
    expect(result.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── Audit trail ───────────────────────────────────────────────────────────────

describe("exportAuditLogToSiem – audit trail", () => {
  it("records an audit.siem_export_completed entry on success", async () => {
    (prisma.auditLog as any) = {
      findMany: jest.fn().mockResolvedValue([makeRow("r-1")]),
    };

    await exportAuditLogToSiem(
      { from, to, requestorAddress: "G-ADMIN" },
      SECRET,
      async () => {}
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "audit.siem_export_completed",
        actorAddress: "G-ADMIN",
        metadata: expect.objectContaining({
          exportId: expect.any(String),
          totalEvents: 1,
          chainHash: expect.any(String),
        }),
      })
    );
  });
});

// ── PII redaction levels (issue #1104) ────────────────────────────────────────

describe("exportAuditLogToSiem – redaction levels", () => {
  const ACTOR = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW";

  function piiRow(id: string, action: string, createdAt: string) {
    return {
      id,
      action,
      actorAddress: ACTOR,
      ipAddress: "203.0.113.45",
      metadata: {
        loanId: "L1",
        email: "borrower@example.com",
        employerName: "Acme Corp",
        description: "kept",
        nested: { ipAddress: "198.51.100.7", status: "approved" },
      },
      createdAt: new Date(createdAt),
    };
  }

  const rows = [
    piiRow("r-1", "loan.approved", "2026-08-01T06:00:00Z"),
    piiRow("r-2", "kyc.reviewed", "2026-08-01T07:00:00Z"),
    piiRow("r-3", "loan.approved", "2026-08-01T08:00:00Z"),
  ];

  async function runExport(redactionLevel?: "full" | "partial" | "aggregate", format?: "ndjson" | "cef") {
    (prisma.auditLog as any) = { findMany: jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]) };
    const lines: string[] = [];
    const result = await exportAuditLogToSiem({ from, to, redactionLevel, format }, SECRET, async (page) => {
      lines.push(...page);
    });
    return { result, lines };
  }

  it("full: exports every field unchanged", async () => {
    const { result, lines } = await runExport("full");
    expect(result.redactionLevel).toBe("full");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first.actorAddress).toBe(ACTOR);
    expect(first.ipAddress).toBe("203.0.113.45");
    expect(first.metadata.email).toBe("borrower@example.com");
    expect(first.metadata.nested.ipAddress).toBe("198.51.100.7");
  });

  it("partial: keeps one row per event but masks the actor, truncates the IP, and redacts PII metadata", async () => {
    const { result, lines } = await runExport("partial");
    expect(result.redactionLevel).toBe("partial");
    expect(lines).toHaveLength(3);
    const first = JSON.parse(lines[0]);
    expect(first.id).toBe("r-1");
    expect(first.action).toBe("loan.approved");
    expect(first.actorAddress).toBe(`${ACTOR.slice(0, 4)}…${ACTOR.slice(-4)}`);
    expect(first.ipAddress).toBe("203.0.113.0");
    expect(first.metadata).toEqual({
      loanId: "L1",
      email: "[REDACTED]",
      employerName: "[REDACTED]",
      description: "kept",
      nested: { ipAddress: "[REDACTED]", status: "approved" },
    });
    expect(lines.join("\n")).not.toContain("borrower@example.com");
    expect(lines.join("\n")).not.toContain(ACTOR);
  });

  it("partial CEF output carries no full actor address or IP", async () => {
    const { lines } = await runExport("partial", "cef");
    expect(lines[0]).toContain("src=203.0.113.0");
    expect(lines.join("\n")).not.toContain(ACTOR);
    expect(lines.join("\n")).not.toContain("203.0.113.45");
  });

  it("aggregate: emits only per-action counts, with no per-event or personal data", async () => {
    const { result, lines } = await runExport("aggregate");
    expect(result.redactionLevel).toBe("aggregate");
    expect(result.totalEvents).toBe(3);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { action: "kyc.reviewed", count: 1, firstSeen: "2026-08-01T07:00:00.000Z", lastSeen: "2026-08-01T07:00:00.000Z" },
      { action: "loan.approved", count: 2, firstSeen: "2026-08-01T06:00:00.000Z", lastSeen: "2026-08-01T08:00:00.000Z" },
    ]);
    const joined = lines.join("\n");
    expect(joined).not.toContain(ACTOR);
    expect(joined).not.toContain("203.0.113");
    expect(joined).not.toContain("borrower@example.com");
    expect(joined).not.toContain("r-1");
  });

  it("aggregate CEF output is counts only", async () => {
    const { lines } = await runExport("aggregate", "cef");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^CEF:0\|RemitMortgage\|AuditLog\|1\.0\|aggregate\|loan\.approved\|1\|cnt=2 /);
    expect(lines.join("\n")).not.toContain(ACTOR);
  });

  it("defaults to the most redacted level (aggregate) when none is chosen", async () => {
    const { result, lines } = await runExport(undefined);
    expect(result.redactionLevel).toBe(DEFAULT_EXPORT_REDACTION_LEVEL);
    expect(DEFAULT_EXPORT_REDACTION_LEVEL).toBe("aggregate");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).not.toHaveProperty("actorAddress");
  });

  it.each(["full", "partial", "aggregate"] as const)(
    "records the %s level in the export audit entry",
    async (level) => {
      await runExport(level);
      expect(mockLogAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "audit.siem_export_completed",
          metadata: expect.objectContaining({ redactionLevel: level, totalEvents: 3 }),
        })
      );
    }
  );

  it("records the default level in the audit entry when none is chosen", async () => {
    await runExport(undefined);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ redactionLevel: "aggregate" }) })
    );
  });
});

describe("exportRedaction helpers", () => {
  it("resolves the requested level, defaulting to the most redacted and rejecting unknown values", () => {
    expect(resolveExportRedactionLevel(undefined)).toBe("aggregate");
    expect(resolveExportRedactionLevel(null)).toBe("aggregate");
    expect(resolveExportRedactionLevel("full")).toBe("full");
    expect(resolveExportRedactionLevel("partial")).toBe("partial");
    expect(resolveExportRedactionLevel("everything")).toBeNull();
    expect(resolveExportRedactionLevel(1)).toBeNull();
  });

  it("truncates IPv4 and IPv6 addresses to their network", () => {
    expect(truncateIp("10.0.0.1")).toBe("10.0.0.0");
    expect(truncateIp("::ffff:192.168.4.20")).toBe("192.168.4.0");
    expect(truncateIp("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3::");
    expect(truncateIp(null)).toBeNull();
  });

  it("masks identifiers, fully redacting short ones", () => {
    expect(maskIdentifier("GABCDEFGHIJKLMNOP")).toBe("GABC…MNOP");
    expect(maskIdentifier("short")).toBe("[REDACTED]");
    expect(maskIdentifier(null)).toBeNull();
  });

  it("redacts PII keys by word, without catching unrelated keys", () => {
    expect(
      redactMetadata({
        client_ip: "1.2.3.4",
        userAgent: "Mozilla",
        taxId: "123",
        description: "fine",
        shipping: "fine",
        items: [{ phoneNumber: "555" }],
      })
    ).toEqual({
      client_ip: "[REDACTED]",
      userAgent: "[REDACTED]",
      taxId: "[REDACTED]",
      description: "fine",
      shipping: "fine",
      items: [{ phoneNumber: "[REDACTED]" }],
    });
  });
});
