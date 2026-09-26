// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { streamVerificationPdf, VerificationReport } from "../services/pdf";
import { RemittanceAnalysis } from "../services/stellar";
import { Writable } from "stream";
import PDFDocument from "pdfkit";

// Mock pdfkit to capture layout calls instead of binary streams
jest.mock("pdfkit");

describe("PDF Snapshot Tests", () => {
  let docMock: any;
  let mockStream: NodeJS.WritableStream;

  beforeEach(() => {
    (PDFDocument as unknown as jest.Mock).mockClear();
    
    docMock = {
      y: 0,
      page: { width: 600, height: 800 },
      pipe: jest.fn(),
      rect: jest.fn().mockReturnThis(),
      fill: jest.fn().mockReturnThis(),
      fillColor: jest.fn().mockReturnThis(),
      fontSize: jest.fn().mockReturnThis(),
      font: jest.fn().mockReturnThis(),
      text: jest.fn().mockReturnThis(),
      moveDown: jest.fn().mockImplementation(function (this: any, n = 1) { 
        this.y += n * 10; 
        return this; 
      }),
      roundedRect: jest.fn().mockReturnThis(),
      moveTo: jest.fn().mockReturnThis(),
      lineTo: jest.fn().mockReturnThis(),
      lineWidth: jest.fn().mockReturnThis(),
      strokeColor: jest.fn().mockReturnThis(),
      stroke: jest.fn().mockReturnThis(),
      end: jest.fn(),
    };

    (PDFDocument as unknown as jest.Mock).mockImplementation(() => docMock);

    mockStream = new Writable({
      write(chunk, encoding, callback) { callback(); }
    });
  });

  const mockAnalysis: RemittanceAnalysis = {
    senderAddress: "GTEST_SENDER",
    recipientAddress: "GTEST_RECIPIENT",
    totalPayments: 12,
    totalAmountUSDC: "6000",
    averageAmountUSDC: "500",
    standardDeviation: 50,
    spanMonths: 12,
    firstPayment: "2023-01-01T00:00:00.000Z",
    lastPayment: "2024-01-01T00:00:00.000Z",
    eligible: true,
    reason: "Meets minimum requirements"
  };

  it("should maintain layout and text rendering for happy path", () => {
    const report: VerificationReport = {
      reportId: "test-report-456",
      generatedAt: "2024-01-15T10:00:00.000Z",
      analysis: mockAnalysis,
      reportHash: "mocked-hash"
    };

    streamVerificationPdf(report, mockStream);
    
    expect(docMock.text.mock.calls).toMatchSnapshot("pdf-text-calls");
    expect(docMock.rect.mock.calls).toMatchSnapshot("pdf-rect-calls");
    expect(docMock.fillColor.mock.calls).toMatchSnapshot("pdf-color-calls");
  });

  it("should maintain layout and text rendering for edge cases (long text, missing fields)", () => {
    const edgeCaseAnalysis: RemittanceAnalysis = {
      ...mockAnalysis,
      senderAddress: "G" + "A".repeat(50) + "VERY_LONG_STELLAR_ADDRESS_THAT_EXCEEDS_NORMAL_LENGTH",
      totalPayments: 0,
      totalAmountUSDC: "1,234,567.89", // Multi-currency formatted
      averageAmountUSDC: "0",
      standardDeviation: -10,
      spanMonths: 0,
      firstPayment: "",
      lastPayment: "",
      eligible: false,
      reason: "Missing history and " + "very long reason string ".repeat(10)
    };

    const report: VerificationReport = {
      reportId: "test-edge-case-report",
      generatedAt: "2024-01-15T10:00:00.000Z",
      analysis: edgeCaseAnalysis,
      reportHash: "mocked-hash-edge"
    };

    streamVerificationPdf(report, mockStream);
    
    expect(docMock.text.mock.calls).toMatchSnapshot("pdf-edge-text-calls");
  });
});
