import { jsPDF } from "jspdf";

export type LoanSummaryForPdf = {
  principal: number;
  interestRateBps: number;
  totalOwed: number;
  repaid: number;
  remaining: number;
};

export type PaymentRecordForPdf = {
  date: string;
  amount: number;
  hash: string;
};

export function generatePaymentHistoryPdf(
  summary: LoanSummaryForPdf,
  records: PaymentRecordForPdf[]
): jsPDF {
  const doc = new jsPDF();

  doc.setFontSize(20);
  doc.text("Borrower Payment History", 14, 22);

  doc.setFontSize(12);
  doc.text(`Principal: $${summary.principal.toFixed(2)}`, 14, 32);
  doc.text(`Interest Rate: ${(summary.interestRateBps / 100).toFixed(1)}%`, 14, 38);
  doc.text(`Total Owed: $${summary.totalOwed.toFixed(2)}`, 14, 44);
  doc.text(`Amount Repaid: $${summary.repaid.toFixed(2)}`, 14, 50);
  doc.text(`Remaining Balance: $${summary.remaining.toFixed(2)}`, 14, 56);

  doc.setFontSize(14);
  doc.text("Payment Records", 14, 70);

  let y = 80;

  doc.setFontSize(10);
  doc.text("Date", 14, y);
  doc.text("Amount", 50, y);
  doc.text("Principal", 80, y);
  doc.text("Interest", 110, y);
  doc.text("Running Bal", 140, y);

  y += 5;
  doc.line(14, y, 196, y);
  y += 5;

  let runningBalance = summary.totalOwed;

  const sortedRecords = [...records].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const principalFraction =
    summary.totalOwed > 0 ? summary.principal / summary.totalOwed : 0;

  for (const record of sortedRecords) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }

    const principalPart = record.amount * principalFraction;
    const interestPart = record.amount - principalPart;
    runningBalance -= record.amount;

    doc.text(new Date(record.date).toLocaleDateString(), 14, y);
    doc.text(`$${record.amount.toFixed(2)}`, 50, y);
    doc.text(`$${principalPart.toFixed(2)}`, 80, y);
    doc.text(`$${interestPart.toFixed(2)}`, 110, y);
    doc.text(`$${Math.max(0, runningBalance).toFixed(2)}`, 140, y);

    y += 8;
  }

  return doc;
}
