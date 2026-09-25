import { generatePaymentHistoryPdf } from "../src/lib/paymentHistoryPdf";
import { jsPDF } from "jspdf";

jest.mock("jspdf");

describe("generatePaymentHistoryPdf", () => {
  beforeEach(() => {
    (jsPDF as jest.Mock).mockClear();
    // Reset any prototype methods we might mock
    (jsPDF.prototype.text as jest.Mock) = jest.fn();
    (jsPDF.prototype.setFontSize as jest.Mock) = jest.fn();
    (jsPDF.prototype.line as jest.Mock) = jest.fn();
    (jsPDF.prototype.addPage as jest.Mock) = jest.fn();
  });

  it("should generate a PDF with the correct structure and content", () => {
    const summary = {
      principal: 10000,
      interestRateBps: 500, // 5%
      totalOwed: 10500,
      repaid: 2000,
      remaining: 8500,
    };

    const records = [
      {
        date: "2023-11-01T12:00:00Z",
        amount: 1000,
        hash: "hash1",
      },
      {
        date: "2023-12-01T12:00:00Z",
        amount: 1000,
        hash: "hash2",
      },
    ];

    const doc = generatePaymentHistoryPdf(summary, records);

    expect(doc).toBeDefined();
    
    // Check if expected text elements are in the document
    const textCalls = (jsPDF.prototype.text as jest.Mock).mock.calls;
    expect(textCalls).toMatchSnapshot("text-calls");
    
    const lineCalls = (jsPDF.prototype.line as jest.Mock).mock.calls;
    expect(lineCalls).toMatchSnapshot("line-calls");
  });
});
