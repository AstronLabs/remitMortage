// Copyright (c) 2026 RemitMortgage Protocol Contributors
// SPDX-License-Identifier: MIT

import {
  levenshteinDistance,
  normalizeString,
  calculateSimilarityScore,
  compareApplicants,
  checkDuplicateApplicants,
  logReviewerDecision,
  DUP_SIMILARITY_THRESHOLD,
} from "../utils/fuzzyMatch.js";

describe("Fuzzy Match & Duplicate Applicant Detection (#496)", () => {
  describe("normalizeString", () => {
    it("converts to lowercase, removes punctuation, collapses spaces", () => {
      expect(normalizeString("  John-Doe, Jr.  ")).toBe("john doe jr");
      expect(normalizeString("Apt 4B, 123 Main St.")).toBe("apt 4b 123 main st");
      expect(normalizeString("")).toBe("");
      expect(normalizeString(null)).toBe("");
    });
  });

  describe("levenshteinDistance", () => {
    it("returns 0 for identical normalized strings", () => {
      expect(levenshteinDistance("John Doe", "john doe")).toBe(0);
      expect(levenshteinDistance("123 Main St.", "123 main st")).toBe(0);
    });

    it("calculates single character edit distance", () => {
      expect(levenshteinDistance("Jon Doe", "John Doe")).toBe(1);
      expect(levenshteinDistance("Smith", "Smyth")).toBe(1);
    });

    it("calculates distance for completely different strings", () => {
      expect(levenshteinDistance("Alice Johnson", "Bob Smith")).toBeGreaterThan(5);
    });
  });

  describe("calculateSimilarityScore", () => {
    it("returns 1.0 for exact matches", () => {
      expect(calculateSimilarityScore("Jane Doe", "Jane Doe")).toBe(1.0);
    });

    it("returns high score (>= 0.8) for minor typos", () => {
      const score = calculateSimilarityScore("Alexander Hamilton", "Alexandr Hamilton");
      expect(score).toBeGreaterThanOrEqual(DUP_SIMILARITY_THRESHOLD);
    });

    it("returns low score (< 0.5) for distinct names", () => {
      const score = calculateSimilarityScore("Alexander Hamilton", "George Washington");
      expect(score).toBeLessThan(0.5);
    });
  });

  describe("compareApplicants", () => {
    it("flags high similarity match for manual review", () => {
      const source = {
        fullName: "Robert C. Martin",
        address: "500 Oak St, Chicago IL",
        idDocumentNumber: "ID-987654321",
      };
      const target = {
        id: "applicant-101",
        fullName: "Robert Martin",
        address: "500 Oak Street, Chicago IL",
        idDocumentNumber: "ID-987654321",
      };

      const result = compareApplicants(source, target);
      expect(result.flaggedForReview).toBe(true);
      expect(result.matchedApplicantId).toBe("applicant-101");
      expect(result.matchedFields).toContain("idDocumentNumber");
      expect(result.overallScore).toBeGreaterThanOrEqual(DUP_SIMILARITY_THRESHOLD);
    });

    it("does not flag completely distinct applicants", () => {
      const source = {
        fullName: "Alice Smith",
        address: "100 Pine St, Seattle WA",
        idDocumentNumber: "PASSPORT-1111",
      };
      const target = {
        id: "applicant-202",
        fullName: "Charlie Brown",
        address: "999 Elm St, Boston MA",
        idDocumentNumber: "PASSPORT-9999",
      };

      const result = compareApplicants(source, target);
      expect(result.flaggedForReview).toBe(false);
      expect(result.matchedFields).toHaveLength(0);
    });
  });

  describe("checkDuplicateApplicants", () => {
    const existing = [
      {
        id: "app-1",
        fullName: "Sarah Connor",
        address: "77 SkyNet Way, Los Angeles CA",
        idDocumentNumber: "DL-12345678",
      },
      {
        id: "app-2",
        fullName: "Kyle Reese",
        address: "2029 Future Blvd, Los Angeles CA",
        idDocumentNumber: "DL-87654321",
      },
    ];

    it("sets status MANUAL_REVIEW when high similarity duplicate candidate found", () => {
      const newApplicant = {
        id: "app-new",
        fullName: "Sara Connor", // minor typo
        address: "77 Skynet Way, Los Angeles CA",
        idDocumentNumber: "DL-12345678", // exact match
      };

      const result = checkDuplicateApplicants(newApplicant, existing);
      expect(result.isDuplicate).toBe(true);
      expect(result.status).toBe("MANUAL_REVIEW");
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].matchedApplicantId).toBe("app-1");
    });

    it("sets status PENDING when no duplicates detected", () => {
      const newApplicant = {
        id: "app-new-2",
        fullName: "John Matrix",
        address: "123 Commando Ln, Val Verde",
        idDocumentNumber: "DL-55555555",
      };

      const result = checkDuplicateApplicants(newApplicant, existing);
      expect(result.isDuplicate).toBe(false);
      expect(result.status).toBe("PENDING");
      expect(result.matches).toHaveLength(0);
    });
  });

  describe("logReviewerDecision", () => {
    it("creates audit log for reviewer approval decision", () => {
      const log = logReviewerDecision("loan-app-1", "admin-user", "APPROVED", "Verified identity documents manually");
      expect(log.applicationId).toBe("loan-app-1");
      expect(log.reviewerId).toBe("admin-user");
      expect(log.decision).toBe("APPROVED");
      expect(log.reason).toBe("Verified identity documents manually");
      expect(log.timestamp).toBeDefined();
    });

    it("creates audit log for reviewer rejection decision", () => {
      const log = logReviewerDecision("loan-app-2", "admin-user", "REJECTED", "Confirmed duplicate fraudulent application");
      expect(log.applicationId).toBe("loan-app-2");
      expect(log.decision).toBe("REJECTED");
    });
  });
});
