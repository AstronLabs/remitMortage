// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import PDFDocument from "pdfkit";
import crypto from "crypto";
import { RemittanceAnalysis } from "./stellar.js";

export interface VerificationReport {
  reportId: string;
  generatedAt: string;
  analysis: RemittanceAnalysis;
  reportHash: string;
}

/**
 * Generates a SHA-256 hash of the report content for on-chain anchoring.
 * The hash is deterministic — the same analysis data always produces the
 * same hash, making it suitable as a tamper-evident anchor.
 */
export function hashReportContent(
  reportId: string,
  generatedAt: string,
  analysis: RemittanceAnalysis
): string {
  const content = JSON.stringify({ reportId, generatedAt, analysis });
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Streams a branded PDF verification report for the given analysis.
 *
 * @param report  The full report object including metadata and analysis.
 * @param stream  A writable stream (e.g. express Response) to pipe the PDF into.
 */
export function streamVerificationPdf(
  report: VerificationReport,
  stream: NodeJS.WritableStream
): void {
  const { reportId, generatedAt, analysis, reportHash } = report;

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: "RemitMortgage Verification Report",
      Author: "RemitMortgage Protocol",
      Subject: "Remittance Eligibility Verification",
    },
  });

  doc.pipe(stream);

  // ── Header / Branding ────────────────────────────────────────────────
  doc
    .rect(0, 0, doc.page.width, 90)
    .fill("#1e293b"); // dark navy brand header

  doc
    .fillColor("#6366f1")
    .fontSize(22)
    .font("Helvetica-Bold")
    .text("Remit", 50, 28, { continued: true })
    .fillColor("#ffffff")
    .text("Mortgage");

  doc
    .fillColor("#94a3b8")
    .fontSize(9)
    .font("Helvetica")
    .text("Remittance-Backed Property Financing on Stellar", 50, 58);

  doc
    .fillColor("#ffffff")
    .fontSize(9)
    .text("VERIFICATION REPORT", 50, 72, { align: "right" });

  // ── Report Metadata ──────────────────────────────────────────────────
  doc.moveDown(4);
  doc
    .fillColor("#1e293b")
    .fontSize(16)
    .font("Helvetica-Bold")
    .text("Remittance Eligibility Analysis", { align: "center" });

  doc.moveDown(0.5);
  doc
    .fillColor("#64748b")
    .fontSize(9)
    .font("Helvetica")
    .text(`Report ID: ${reportId}`, { align: "center" })
    .text(`Generated: ${new Date(generatedAt).toUTCString()}`, { align: "center" });

  // Eligibility badge
  const eligible = analysis.eligible;
  const badgeColor = eligible ? "#16a34a" : "#dc2626";
  const badgeText = eligible ? "✓  ELIGIBLE" : "✗  NOT ELIGIBLE";
  doc.moveDown(1);
  doc
    .roundedRect(
      (doc.page.width - 180) / 2,
      doc.y,
      180,
      28,
      6
    )
    .fill(badgeColor);
  doc
    .fillColor("#ffffff")
    .fontSize(12)
    .font("Helvetica-Bold")
    .text(badgeText, 0, doc.y - 22, { align: "center" });

  doc.moveDown(2);

  // ── Divider ──────────────────────────────────────────────────────────
  const dividerY = doc.y;
  doc
    .moveTo(50, dividerY)
    .lineTo(doc.page.width - 50, dividerY)
    .lineWidth(0.5)
    .strokeColor("#e2e8f0")
    .stroke();
  doc.moveDown(1);

  // ── Address Section ──────────────────────────────────────────────────
  drawSectionHeader(doc, "Wallet Addresses");

  drawTableRow(doc, "Sender Address", analysis.senderAddress, true);
  drawTableRow(doc, "Recipient Address", analysis.recipientAddress, false);
  doc.moveDown(1);

  // ── Payment History ──────────────────────────────────────────────────
  drawSectionHeader(doc, "Payment History Summary");

  const rows: [string, string][] = [
    ["Total Payments", `${analysis.totalPayments}`],
    ["Total Volume (USDC)", `$${analysis.totalAmountUSDC}`],
    ["Average Payment (USDC)", `$${analysis.averageAmountUSDC}`],
    ["First Payment", analysis.firstPayment ? new Date(analysis.firstPayment).toDateString() : "—"],
    ["Last Payment", analysis.lastPayment ? new Date(analysis.lastPayment).toDateString() : "—"],
    ["Payment Span", `${analysis.spanMonths} month${analysis.spanMonths !== 1 ? "s" : ""}`],
  ];

  rows.forEach(([label, value], i) => {
    drawTableRow(doc, label, value, i % 2 === 0);
  });

  doc.moveDown(1);

  // ── Eligibility Section ──────────────────────────────────────────────
  drawSectionHeader(doc, "Eligibility Assessment");
  drawTableRow(doc, "Verdict", eligible ? "Passes minimum requirements" : "Does not meet requirements", true);
  drawTableRow(doc, "Reason", analysis.reason, false);

  doc.moveDown(1);

  // ── Minimum Requirements ─────────────────────────────────────────────
  drawSectionHeader(doc, "Minimum Requirements");
  drawTableRow(doc, "Minimum Payments", "6 payments", true);
  drawTableRow(doc, "Minimum Duration", "3 months", false);
  drawTableRow(doc, "Asset", "USDC (Stellar)", true);

  doc.moveDown(2);

  // ── On-Chain Hash / Footer ───────────────────────────────────────────
  const hashY = doc.page.height - 120;
  doc
    .moveTo(50, hashY)
    .lineTo(doc.page.width - 50, hashY)
    .lineWidth(0.5)
    .strokeColor("#e2e8f0")
    .stroke();

  doc
    .fillColor("#64748b")
    .fontSize(8)
    .font("Helvetica")
    .text("On-Chain Anchor Hash (SHA-256)", 50, hashY + 8);

  doc
    .fillColor("#374151")
    .fontSize(7)
    .font("Courier")
    .text(reportHash, 50, hashY + 20, { width: doc.page.width - 100 });

  doc
    .fillColor("#94a3b8")
    .fontSize(7.5)
    .font("Helvetica")
    .text(
      "DISCLAIMER: This report is generated for informational purposes only and does not constitute " +
        "legal, financial, or mortgage advice. The hash above may be anchored on-chain in the " +
        "RemitMortgage verification registry contract for auditability.",
      50,
      hashY + 40,
      { width: doc.page.width - 100, align: "justify" }
    );

  doc
    .fillColor("#cbd5e1")
    .fontSize(7.5)
    .text(
      `© ${new Date().getFullYear()} RemitMortgage · Built on Stellar · MIT License`,
      50,
      hashY + 72,
      { align: "center" }
    );

  doc.end();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function drawSectionHeader(doc: InstanceType<typeof PDFDocument>, title: string) {
  doc
    .fillColor("#1e293b")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(title);
  doc
    .moveTo(50, doc.y + 2)
    .lineTo(doc.page.width - 50, doc.y + 2)
    .lineWidth(1)
    .strokeColor("#6366f1")
    .stroke();
  doc.moveDown(0.6);
}

function drawTableRow(
  doc: InstanceType<typeof PDFDocument>,
  label: string,
  value: string,
  shaded: boolean
) {
  const rowHeight = 18;
  const rowY = doc.y;
  const labelX = 55;
  const valueX = 230;
  const rowWidth = doc.page.width - 100;

  if (shaded) {
    doc.rect(50, rowY, rowWidth, rowHeight).fill("#f8fafc");
  }

  doc
    .fillColor("#475569")
    .fontSize(9)
    .font("Helvetica-Bold")
    .text(label, labelX, rowY + 4, { width: 170 });

  doc
    .fillColor("#1e293b")
    .fontSize(9)
    .font("Helvetica")
    .text(value, valueX, rowY + 4, { width: rowWidth - (valueX - 50) });

  doc.y = rowY + rowHeight + 1;
}
