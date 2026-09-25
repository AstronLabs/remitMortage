// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { jsPDF } from "jspdf";

export type StatementMetadata = {
  borrowerName: string;
  borrowerAddress: string;
  walletType: string;
  generatedAt?: string;
};

export type StatementSummaryItem = {
  label: string;
  value: string;
};

export type StatementRow = {
  date: string;
  type: string;
  amount: string;
  status: string;
  reference: string;
  counterparty: string;
  notes?: string;
};

export type StatementPayload = {
  title: string;
  subtitle: string;
  metadata: StatementMetadata;
  summary: StatementSummaryItem[];
  rows: StatementRow[];
};

function escapeCsvCell(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildStatementCsv(payload: StatementPayload): string {
  const generatedAt = payload.metadata.generatedAt ?? new Date().toISOString();
  const lines = [
    ["Statement Title", escapeCsvCell(payload.title)].join(","),
    ["Statement Subtitle", escapeCsvCell(payload.subtitle)].join(","),
    ["Borrower Name", escapeCsvCell(payload.metadata.borrowerName)].join(","),
    ["Borrower Address", escapeCsvCell(payload.metadata.borrowerAddress)].join(","),
    ["Wallet Type", escapeCsvCell(payload.metadata.walletType)].join(","),
    ["Generated At", escapeCsvCell(generatedAt)].join(","),
    "",
    ["Summary", "Value"].join(","),
    ...payload.summary.map((item) =>
      [escapeCsvCell(item.label), escapeCsvCell(item.value)].join(",")
    ),
    "",
    ["Date", "Type", "Amount", "Status", "Reference", "Counterparty", "Notes"].join(","),
    ...payload.rows.map((row) =>
      [row.date, row.type, row.amount, row.status, row.reference, row.counterparty, row.notes ?? ""]
        .map(escapeCsvCell)
        .join(",")
    ),
  ];

  return lines.join("\n");
}

function downloadTextFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadStatementCsv(payload: StatementPayload, filename: string) {
  downloadTextFile(buildStatementCsv(payload), filename, "text/csv;charset=utf-8;");
}

function drawWrappedLines(doc: jsPDF, text: string, x: number, y: number, maxWidth: number) {
  const lines = doc.splitTextToSize(text, maxWidth) as string[];
  doc.text(lines, x, y);
  return y + lines.length * 12;
}

export function downloadStatementPdf(payload: StatementPayload, filename: string) {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const contentWidth = pageWidth - margin * 2;
  let cursorY = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  cursorY = drawWrappedLines(doc, payload.title, margin, cursorY, contentWidth);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  cursorY += 6;
  cursorY = drawWrappedLines(doc, payload.subtitle, margin, cursorY, contentWidth);

  cursorY += 10;
  doc.setFontSize(12);
  doc.setFont("helvetica", "bold");
  cursorY = drawWrappedLines(doc, "Borrower metadata", margin, cursorY, contentWidth);

  doc.setFont("helvetica", "normal");
  const metadataLines = [
    `Name: ${payload.metadata.borrowerName}`,
    `Address: ${payload.metadata.borrowerAddress}`,
    `Wallet: ${payload.metadata.walletType}`,
    `Generated at: ${payload.metadata.generatedAt ?? new Date().toISOString()}`,
  ];
  for (const line of metadataLines) {
    if (cursorY > pageHeight - 40) {
      doc.addPage();
      cursorY = margin;
    }
    cursorY = drawWrappedLines(doc, line, margin, cursorY + 6, contentWidth);
  }

  cursorY += 8;
  doc.setFont("helvetica", "bold");
  cursorY = drawWrappedLines(doc, "Summary", margin, cursorY, contentWidth);
  doc.setFont("helvetica", "normal");
  for (const item of payload.summary) {
    const line = `${item.label}: ${item.value}`;
    if (cursorY > pageHeight - 40) {
      doc.addPage();
      cursorY = margin;
    }
    cursorY = drawWrappedLines(doc, line, margin, cursorY + 4, contentWidth);
  }

  cursorY += 8;
  doc.setFont("helvetica", "bold");
  cursorY = drawWrappedLines(doc, "Verified transactions", margin, cursorY, contentWidth);
  doc.setFontSize(10.5);
  doc.setFont("helvetica", "normal");

  if (payload.rows.length === 0) {
    cursorY = drawWrappedLines(
      doc,
      "No verified transactions matched the current filters.",
      margin,
      cursorY + 4,
      contentWidth
    );
  }

  for (const row of payload.rows) {
    const block = [
      `${row.date} | ${row.type} | ${row.amount} | ${row.status}`,
      `Reference: ${row.reference}`,
      `Counterparty: ${row.counterparty}`,
      row.notes ? `Notes: ${row.notes}` : null,
    ].filter(Boolean) as string[];

    const blockHeight = block.length * 12 + 10;
    if (cursorY + blockHeight > pageHeight - 40) {
      doc.addPage();
      cursorY = margin;
    }

    doc.setDrawColor(148, 163, 184);
    doc.roundedRect(margin, cursorY, contentWidth, blockHeight, 8, 8);
    let blockY = cursorY + 14;
    for (const line of block) {
      blockY = drawWrappedLines(doc, line, margin + 12, blockY, contentWidth - 24);
    }
    cursorY += blockHeight + 10;
  }

  doc.save(filename);
}

export function createStatementMetadata(params: {
  borrowerName: string;
  borrowerAddress: string;
  walletType: string;
}): StatementMetadata {
  return {
    ...params,
    generatedAt: new Date().toISOString(),
  };
}
