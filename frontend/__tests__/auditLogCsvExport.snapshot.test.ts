// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

/**
 * Snapshot tests for the admin audit log CSV export (issue #680).
 *
 * Compliance staff feed this export into external spreadsheets/tools with
 * fixed column expectations. Unlike the assertions in AuditLogViewer.test.tsx
 * (which check individual escaping rules), these snapshots pin the *entire*
 * rendered CSV output so an accidental column reorder, rename, or formatting
 * change shows up as a snapshot diff during review instead of silently
 * shipping. Jest writes the baseline to __snapshots__ the first time this
 * file runs; any intentional export format change must go through
 * `jest -u` so the diff is visible in the PR.
 */

import { exportToCsv, AuditLogEntry } from "../src/lib/auditApi";

describe("audit log CSV export format stability", () => {
  it("matches the documented column header contract", () => {
    expect(exportToCsv([]).split("\n")[0]).toMatchInlineSnapshot(
      `"ID,Action,Actor Address,IP Address,Metadata,Created At"`
    );
  });

  it("matches the snapshot for an empty result set", () => {
    expect(exportToCsv([])).toMatchSnapshot();
  });

  it("matches the snapshot for a single, simple record", () => {
    const logs: AuditLogEntry[] = [
      {
        id: "audit-000",
        action: "login",
        actorAddress: "GSIMPLE00000000000000000000000000000000000000000",
        ipAddress: "192.0.2.1",
        metadata: { method: "passkey" },
        createdAt: "2026-01-10T08:00:00.000Z",
      },
    ];

    expect(exportToCsv(logs)).toMatchSnapshot();
  });

  it("matches the snapshot for a representative, mixed-shape batch", () => {
    const logs: AuditLogEntry[] = [
      {
        id: "audit-001",
        action: "loan_approved",
        actorAddress: "GABCDEF1234567890",
        ipAddress: "203.0.113.10",
        metadata: { loanId: "loan-9001", amount: 250000, currency: "USD" },
        createdAt: "2026-01-15T09:30:00.000Z",
      },
      {
        // Null actor/IP: system-initiated actions must still render the
        // empty-string columns rather than the literal string "null".
        id: "audit-002",
        action: "note_added",
        actorAddress: null,
        ipAddress: null,
        metadata: { note: "Escalated to underwriting, pending docs" },
        createdAt: "2026-01-15T10:05:00.000Z",
      },
      {
        // Array-valued metadata field.
        id: "audit-003",
        action: "kyc_flagged",
        actorAddress: "GXYZ0000000000000",
        ipAddress: "198.51.100.23",
        metadata: { reasons: ["expired_id", "address_mismatch"], reviewer: "system" },
        createdAt: "2026-01-15T11:45:00.000Z",
      },
      {
        // Empty metadata object.
        id: "audit-004",
        action: "comment",
        actorAddress: "GQRS111122223333",
        ipAddress: "192.0.2.5",
        metadata: {},
        createdAt: "2026-01-15T12:00:00.000Z",
      },
      {
        // Unicode content, to guard against a future non-UTF8-safe writer.
        id: "audit-005",
        action: "applicant_renamed",
        actorAddress: "GUNI444455556666",
        ipAddress: "192.0.2.9",
        metadata: { previousName: "José Álvarez", newName: "何塞" },
        createdAt: "2026-01-15T13:20:00.000Z",
      },
    ];

    expect(exportToCsv(logs)).toMatchSnapshot();
  });

  it("matches the snapshot for metadata requiring comma/quote/newline escaping", () => {
    const logs: AuditLogEntry[] = [
      {
        id: "audit-010",
        action: "manual_override",
        actorAddress: "GESC1234567890",
        ipAddress: "203.0.113.55",
        metadata: {
          description: 'Reviewer noted: "escalate, do not close" before EOD\nfollow up tomorrow',
        },
        createdAt: "2026-01-20T16:00:00.000Z",
      },
    ];

    expect(exportToCsv(logs)).toMatchSnapshot();
  });
});
