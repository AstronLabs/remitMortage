// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import { hashReportContent, streamVerificationPdf, VerificationReport } from "../services/pdf";
import { RemittanceAnalysis } from "../services/stellar";
import { Writable } from "stream";

describe("PDF Service", () => {
  const mockAnalysis: RemittanceAnalysis = {
    senderAddress: "GTEST_SENDER_ADDRESS_EXAMPLE_1234567890",
    recipientAddress: "GTEST_RECIPIENT_ADDRESS_EXAMPLE_0987654321",
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

  describe("hashReportContent", () => {
    it("should generate a deterministic SHA-256 hash for identical reports", () => {
      const reportId = "test-report-123";
      const generatedAt = "2024-01-15T10:00:00.000Z";

      const hash1 = hashReportContent(reportId, generatedAt, mockAnalysis);
      const hash2 = hashReportContent(reportId, generatedAt, mockAnalysis);

      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA-256 produces 64 hex characters
      expect(hash1).toMatch(/^[a-f0-9]{64}$/); // Valid hex string
    });

    it("should produce different hashes for different report IDs", () => {
      const generatedAt = "2024-01-15T10:00:00.000Z";

      const hash1 = hashReportContent("report-1", generatedAt, mockAnalysis);
      const hash2 = hashReportContent("report-2", generatedAt, mockAnalysis);

      expect(hash1).not.toBe(hash2);
    });

    it("should produce different hashes for different timestamps", () => {
      const reportId = "test-report-123";

      const hash1 = hashReportContent(reportId, "2024-01-15T10:00:00.000Z", mockAnalysis);
      const hash2 = hashReportContent(reportId, "2024-01-15T11:00:00.000Z", mockAnalysis);

      expect(hash1).not.toBe(hash2);
    });

    it("should produce different hashes for different analysis data", () => {
      const reportId = "test-report-123";
      const generatedAt = "2024-01-15T10:00:00.000Z";

      const modifiedAnalysis = {
        ...mockAnalysis,
        totalPayments: 15,
        totalAmountUSDC: "7500"
      };

      const hash1 = hashReportContent(reportId, generatedAt, mockAnalysis);
      const hash2 = hashReportContent(reportId, generatedAt, modifiedAnalysis);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("streamVerificationPdf", () => {
    let mockStream: MockWritableStream;

    class MockWritableStream extends Writable {
      public chunks: Buffer[] = [];
      public isEnded = false;

      _write(chunk: any, encoding: string, callback: (error?: Error | null) => void): void {
        this.chunks.push(Buffer.from(chunk));
        callback();
      }

      end(...args: any[]): this {
        this.isEnded = true;
        return super.end(...args);
      }

      getBuffer(): Buffer {
        return Buffer.concat(this.chunks);
      }
    }

    beforeEach(() => {
      mockStream = new MockWritableStream();
    });

    it("should generate PDF without throwing errors", () => {
      const report: VerificationReport = {
        reportId: "test-report-456",
        generatedAt: "2024-01-15T10:00:00.000Z",
        analysis: mockAnalysis,
        reportHash: hashReportContent("test-report-456", "2024-01-15T10:00:00.000Z", mockAnalysis)
      };

      expect(() => {
        streamVerificationPdf(report, mockStream);
      }).not.toThrow();
    });

    it("should write PDF data to the stream", (done) => {
      const report: VerificationReport = {
        reportId: "test-report-789",
        generatedAt: "2024-01-15T10:00:00.000Z",
        analysis: mockAnalysis,
        reportHash: hashReportContent("test-report-789", "2024-01-15T10:00:00.000Z", mockAnalysis)
      };

      mockStream.on("finish", () => {
        const pdfBuffer = mockStream.getBuffer();
        
        // Verify PDF header signature
        expect(pdfBuffer.length).toBeGreaterThan(0);
        expect(pdfBuffer.toString("utf8", 0, 4)).toBe("%PDF");
        
        done();
      });

      streamVerificationPdf(report, mockStream);
    });

    it("should handle extremely long addresses without throwing", (done) => {
      const longAddressAnalysis: RemittanceAnalysis = {
        ...mockAnalysis,
        senderAddress: "G" + "A".repeat(100) + "VERY_LONG_STELLAR_ADDRESS_THAT_EXCEEDS_NORMAL_LENGTH",
        recipientAddress: "G" + "B".repeat(100) + "ANOTHER_EXTREMELY_LONG_ADDRESS_FOR_TESTING"
      };

      const report: VerificationReport = {
        reportId: "test-long-address",
        generatedAt: "2024-01-15T10:00:00.000Z",
        analysis: longAddressAnalysis,
        reportHash: hashReportContent("test-long-address", "2024-01-15T10:00:00.000Z", longAddressAnalysis)
      };

      mockStream.on("finish", () => {
        const pdfBuffer = mockStream.getBuffer();
        expect(pdfBuffer.length).toBeGreaterThan(0);
        done();
      });

      expect(() => {
        streamVerificationPdf(report, mockStream);
      }).not.toThrow();
    });

    it("should handle negative or zero values in analysis without throwing", (done) => {
      const edgeCaseAnalysis: RemittanceAnalysis = {
        ...mockAnalysis,
        totalPayments: 0,
        totalAmountUSDC: "0",
        averageAmountUSDC: "0",
        standardDeviation: -10,
        spanMonths: 0
      };

      const report: VerificationReport = {
        reportId: "test-edge-case",
        generatedAt: "2024-01-15T10:00:00.000Z",
        analysis: edgeCaseAnalysis,
        reportHash: hashReportContent("test-edge-case", "2024-01-15T10:00:00.000Z", edgeCaseAnalysis)
      };

      mockStream.on("finish", () => {
        const pdfBuffer = mockStream.getBuffer();
        expect(pdfBuffer.length).toBeGreaterThan(0);
        done();
      });

      expect(() => {
        streamVerificationPdf(report, mockStream);
      }).not.toThrow();
    });

    it("should handle empty/undefined date values gracefully", (done) => {
      const noDateAnalysis: RemittanceAnalysis = {
        ...mockAnalysis,
        firstPayment: "",
        lastPayment: ""
      };

      const report: VerificationReport = {
        reportId: "test-no-dates",
        generatedAt: "2024-01-15T10:00:00.000Z",
        analysis: noDateAnalysis,
        reportHash: hashReportContent("test-no-dates", "2024-01-15T10:00:00.000Z", noDateAnalysis)
      };

      mockStream.on("finish", () => {
        const pdfBuffer = mockStream.getBuffer();
        expect(pdfBuffer.length).toBeGreaterThan(0);
        done();
      });

      expect(() => {
        streamVerificationPdf(report, mockStream);
      }).not.toThrow();
    });

    it("should correctly hash report with all fields", () => {
      const reportHash = hashReportContent("test-report-hash", "2024-01-15T10:00:00.000Z", mockAnalysis);
      const report: VerificationReport = {
        reportId: "test-report-hash",
        generatedAt: "2024-01-15T10:00:00.000Z",
        analysis: mockAnalysis,
        reportHash
      };

      // Verify report structure is correct
      expect(report.reportHash).toBe(reportHash);
      expect(report.reportHash).toHaveLength(64);
      expect(report.reportId).toBe("test-report-hash");
      expect(report.analysis).toBe(mockAnalysis);
    });
  });
});
